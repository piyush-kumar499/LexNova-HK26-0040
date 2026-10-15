import type { FastifyBaseLogger } from "fastify";
import type {
  IncidentResponderRow,
  IncidentStatus,
  ResponderStatus,
  SosIncidentRow,
  TriggerType,
} from "../models/sos.model.js";
import type { Database } from "./supabase.service.js";

/**
 * Pre-accept privacy (spec §11): nearby devices see a rounded distance to the
 * incident, never the victim's coordinates. Rounding to 100 m limits
 * trilateration from repeated polls.
 */
export const DISTANCE_ROUNDING_M = 100;

export function roundDistance(meters: number): number {
  return Math.max(
    DISTANCE_ROUNDING_M,
    Math.round(meters / DISTANCE_ROUNDING_M) * DISTANCE_ROUNDING_M,
  );
}

/** What a polling device is allowed to know before accepting. No coordinates. */
export interface NearbyIncidentView {
  incidentId: string;
  status: IncidentStatus;
  triggerType: TriggerType;
  approximateDistanceM: number;
  activatedAt: string;
  responderStatus: ResponderStatus;
}

/**
 * Nearby-device discovery (spec §9). Polling GET /nearby/sos both lists active
 * incidents around the device and records the device as a NOTIFIED responder
 * for each one, so a later ACCEPT is a plain state transition on an existing
 * membership rather than a new join.
 */
export class NearbyService {
  constructor(
    private readonly db: Database,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Registers (or re-reads) the device's NOTIFIED membership for an incident.
   * Idempotent: repeated polls never duplicate rows or move notified_at.
   */
  async registerNotifiedResponder(
    incident: SosIncidentRow,
    deviceId: string,
    distanceM: number,
  ): Promise<{ row: IncidentResponderRow; created: boolean }> {
    const { row, created } = await this.db.insertIncidentResponderIfAbsent({
      incidentId: incident.id,
      deviceId,
      distanceAtNotifyM: distanceM,
      notifiedAt: new Date().toISOString(),
    });

    if (created) {
      const distanceApproxM = roundDistance(distanceM);
      await this.db.appendResponderEvent({
        incidentId: incident.id,
        deviceId,
        eventType: "responder.nearby_notified",
        metadata: { distanceApproxM },
      });
      await this.db.appendAuditLog({
        deviceId,
        incidentId: incident.id,
        eventType: "nearby.responder_notified",
        data: { distanceApproxM },
      });
      this.log.info(
        { incidentId: incident.id, deviceId, distanceApproxM },
        "nearby: device notified of active SOS",
      );
    }

    return { row, created };
  }

  /** Active incidents around a point, sanitized for pre-accept delivery. */
  async listNearbyIncidents(params: {
    deviceId: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
  }): Promise<NearbyIncidentView[]> {
    const found = await this.db.findNearbyActiveIncidents({
      latitude: params.latitude,
      longitude: params.longitude,
      radiusMeters: params.radiusMeters,
      maxResults: params.maxResults,
      excludeDeviceId: params.deviceId,
    });

    const views: NearbyIncidentView[] = [];
    for (const item of found) {
      // Re-read for the authoritative status: the incident may have been
      // resolved or cancelled between the geo query and this point.
      const incident = await this.db.getIncident(item.incidentId);
      if (!incident) continue;
      if (incident.status === "RESOLVED" || incident.status === "CANCELLED") continue;

      const membership = await this.registerNotifiedResponder(
        incident,
        params.deviceId,
        item.distanceM,
      );

      views.push({
        incidentId: incident.id,
        status: incident.status,
        triggerType: incident.trigger_type,
        approximateDistanceM: roundDistance(item.distanceM),
        activatedAt: incident.activated_at,
        responderStatus: membership.row.status,
      });
    }
    return views;
  }
}
