import type { FastifyBaseLogger } from "fastify";
import type {
  CancelSosInput,
  CreateSosInput,
  IncidentEvidenceRow,
  IncidentResponderRow,
  ResolveSosInput,
  ResponderStatus,
  SosIncidentRow,
} from "../models/sos.model.js";
import { assertIncidentTransition } from "../models/sos.model.js";
import type { Database } from "./supabase.service.js";
import { findOrCreate } from "../middleware/idempotency.js";
import { forbidden, notFound } from "../utils/errors.js";

export interface CreateSosResult {
  incident: SosIncidentRow;
  created: boolean;
}

/** Fields safe to reveal about an incident to someone who can see it at all. */
export function toIncidentCore(row: SosIncidentRow) {
  return {
    id: row.id,
    status: row.status,
    triggerType: row.trigger_type,
    activatedAt: row.activated_at,
    deviceTimestamp: row.device_timestamp,
    escalationLevel: row.escalation_level,
    clientRequestId: row.client_request_id,
    cancelReason: row.cancel_reason,
    resolutionReason: row.resolution_reason,
    cancelledAt: row.cancelled_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface IncidentView {
  incident: ReturnType<typeof toIncidentCore>;
  /** Exact coordinates — only for the owner and responders who ACCEPTED. */
  location: { latitude: number; longitude: number; accuracy: number | null } | null;
  evidence: Array<{
    id: string;
    kind: string;
    mediaType: string | null;
    storageRef: string;
    capturedAt: string | null;
    createdAt: string;
  }>;
  responders: ResponderView[];
  calls: Array<{
    id: string;
    provider: string;
    status: string;
    recipientReference: string | null;
    level: number | null;
    startedAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
    endedReason: string | null;
    recordingRef: string | null;
    hasTranscript: boolean;
  }>;
  viewer: { role: "OWNER" | "RESPONDER"; responderStatus?: ResponderStatus };
}

interface ResponderView {
  deviceId: string;
  status: ResponderStatus;
  distanceAtNotifyM: number | null;
  notifiedAt: string;
  acceptedAt: string | null;
  enRouteAt: string | null;
  arrivedAt: string | null;
  declinedAt: string | null;
  withdrawnAt: string | null;
}

function toResponderView(row: IncidentResponderRow): ResponderView {
  return {
    deviceId: row.device_id,
    status: row.status,
    distanceAtNotifyM: row.distance_at_notify_m,
    notifiedAt: row.notified_at,
    acceptedAt: row.accepted_at,
    enRouteAt: row.en_route_at,
    arrivedAt: row.arrived_at,
    declinedAt: row.declined_at,
    withdrawnAt: row.withdrawn_at,
  };
}

function toLocation(row: SosIncidentRow): IncidentView["location"] {
  if (row.latitude === null || row.longitude === null) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.location_accuracy,
  };
}

function toEvidenceView(row: IncidentEvidenceRow): IncidentView["evidence"][number] {
  return {
    id: row.id,
    kind: row.kind,
    mediaType: row.media_type,
    storageRef: row.storage_ref,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  };
}

export class SosService {
  constructor(
    private readonly db: Database,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Idempotent SOS creation (spec §5.4, §11, §14). Same clientRequestId from
   * the same device always returns the same incident. Returns immediately;
   * notification/escalation work happens outside the request path.
   */
  async create(deviceId: string, input: CreateSosInput): Promise<CreateSosResult> {
    let latitude = input.latitude ?? null;
    let longitude = input.longitude ?? null;
    let accuracy = input.locationAccuracy ?? null;

    if (latitude === null) {
      const latest = await this.db.getLatestDeviceLocation(deviceId);
      if (latest) {
        latitude = latest.latitude;
        longitude = latest.longitude;
        accuracy = latest.accuracy;
      }
    }

    const result = await findOrCreate({
      find: () => this.db.findIncidentByClientRequestId(deviceId, input.clientRequestId),
      create: () =>
        this.db.insertSosIncident({
          deviceId,
          triggerType: input.triggerType,
          latitude,
          longitude,
          locationAccuracy: accuracy,
          deviceTimestamp: input.deviceTimestamp,
          // Offline replay keeps the real activation time (spec §14).
          activatedAt: input.deviceTimestamp,
          clientRequestId: input.clientRequestId,
        }),
      readAfterConflict: () =>
        this.db.findIncidentByClientRequestId(deviceId, input.clientRequestId),
    });

    const incident = result.value;

    await this.db.appendAuditLog({
      deviceId,
      incidentId: incident.id,
      eventType: result.created ? "sos.created" : "sos.duplicate_replayed",
      data: {
        triggerType: incident.trigger_type,
        hasLocation: incident.latitude !== null,
      },
    });

    this.log.info(
      {
        incidentId: incident.id,
        deviceId,
        triggerType: incident.trigger_type,
        status: incident.status,
        hasLocation: incident.latitude !== null,
        created: result.created,
      },
      result.created ? "sos.created" : "sos.duplicate_replayed",
    );

    return { incident, created: result.created };
  }

  /**
   * Incident detail with per-viewer scoping (spec §5.5, privacy rules):
   * the owner sees everything; a responder sees the incident and exact
   * location only after ACCEPTED, and never sees evidence or call detail.
   */
  async getIncidentForDevice(deviceId: string, incidentId: string): Promise<IncidentView> {
    const incident = await this.db.getIncident(incidentId);
    if (!incident) throw notFound("INCIDENT_NOT_FOUND", "Incident not found");

    if (incident.device_id === deviceId) {
      const [evidence, responders, calls] = await Promise.all([
        this.db.listIncidentEvidence(incidentId),
        this.db.listIncidentResponders(incidentId),
        this.db.listCallEvents(incidentId),
      ]);

      return {
        incident: toIncidentCore(incident),
        location: toLocation(incident),
        evidence: evidence.map(toEvidenceView),
        responders: responders.map(toResponderView),
        calls: calls.map((call) => ({
          id: call.id,
          provider: call.provider,
          status: call.status,
          recipientReference: call.recipient_reference,
          level: call.level,
          startedAt: call.started_at,
          answeredAt: call.answered_at,
          endedAt: call.ended_at,
          endedReason: call.ended_reason,
          recordingRef: call.recording_ref,
          hasTranscript: call.transcript !== null,
        })),
        viewer: { role: "OWNER" },
      };
    }

    const membership = await this.db.getIncidentResponder(incidentId, deviceId);
    if (!membership) {
      throw forbidden("FORBIDDEN", "You are not part of this incident");
    }
    if (
      membership.status !== "ACCEPTED" &&
      membership.status !== "EN_ROUTE" &&
      membership.status !== "ARRIVED"
    ) {
      throw forbidden(
        "RESPONDER_NOT_ACCEPTED",
        "Accept the alert before viewing incident details",
      );
    }

    return {
      incident: toIncidentCore(incident),
      location: toLocation(incident),
      evidence: [],
      responders: [toResponderView(membership)],
      calls: [],
      viewer: { role: "RESPONDER", responderStatus: membership.status },
    };
  }

  /** Cancel (false alarm) — owner only, ACTIVE/HELP_REQUESTED only. */
  async cancel(
    deviceId: string,
    incidentId: string,
    input: CancelSosInput,
  ): Promise<SosIncidentRow> {
    const incident = await this.requireOwnIncident(deviceId, incidentId);
    assertIncidentTransition(incident.status, "CANCELLED");

    const updated = await this.db.updateIncident(incidentId, {
      status: "CANCELLED",
      cancel_reason: input.reason,
      cancelled_at: new Date().toISOString(),
    });

    await this.db.appendAuditLog({
      deviceId,
      incidentId,
      eventType: "sos.cancelled",
      data: { reason: input.reason, fromStatus: incident.status },
    });
    this.log.info(
      { incidentId, deviceId, reason: input.reason },
      "sos.cancelled",
    );

    return updated;
  }

  /** Resolve — owner only, only after a responder acknowledged (spec §9). */
  async resolve(
    deviceId: string,
    incidentId: string,
    input: ResolveSosInput,
  ): Promise<SosIncidentRow> {
    const incident = await this.requireOwnIncident(deviceId, incidentId);
    assertIncidentTransition(incident.status, "RESOLVED");

    const updated = await this.db.updateIncident(incidentId, {
      status: "RESOLVED",
      resolution_reason: input.resolutionReason,
      resolved_at: new Date().toISOString(),
    });

    await this.db.appendAuditLog({
      deviceId,
      incidentId,
      eventType: "sos.resolved",
      data: { resolutionReason: input.resolutionReason, fromStatus: incident.status },
    });
    this.log.info(
      { incidentId, deviceId, resolutionReason: input.resolutionReason },
      "sos.resolved",
    );

    return updated;
  }

  private async requireOwnIncident(
    deviceId: string,
    incidentId: string,
  ): Promise<SosIncidentRow> {
    const incident = await this.db.getIncident(incidentId);
    if (!incident) throw notFound("INCIDENT_NOT_FOUND", "Incident not found");
    if (incident.device_id !== deviceId) {
      throw forbidden(
        "FORBIDDEN",
        "Only the device that created the incident can do this",
      );
    }
    return incident;
  }
}
