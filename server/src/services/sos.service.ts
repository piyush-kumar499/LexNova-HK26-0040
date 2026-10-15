import type { FastifyBaseLogger } from "fastify";
import type {
  CancelSosInput,
  CreateSosInput,
  IncidentEvidenceRow,
  IncidentResponderRow,
  ResolveSosInput,
  ResponderAction,
  ResponderStatus,
  SosIncidentRow,
} from "../models/sos.model.js";
import {
  ACTION_TO_STATUS,
  assertIncidentTransition,
  assertResponderTransition,
} from "../models/sos.model.js";
import type { Database } from "./supabase.service.js";
import { findOrCreate } from "../middleware/idempotency.js";
import { conflict, forbidden, notFound } from "../utils/errors.js";

export interface CreateSosResult {
  incident: SosIncidentRow;
  created: boolean;
}

/**
 * Post-activation pipeline port (spec §5.4): notifications and escalation run
 * asynchronously after the incident is created; the SOS response never waits
 * for them. Implemented by EscalationService.
 */
export interface IncidentNotifier {
  startForIncident(incident: SosIncidentRow): Promise<void>;
  /**
   * Optional: called when a responder withdraws after accepting, so the
   * escalation chain can resume if nobody else is on the way.
   */
  resumeAfterWithdrawal?(incidentId: string): Promise<void>;
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

export interface ResponderView {
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

export function toResponderView(row: IncidentResponderRow): ResponderView {
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
    private readonly notifier?: IncidentNotifier,
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

    // Fire-and-forget: notification/escalation must never block or fail the
    // SOS response (spec §5.4). Only first creation dispatches; replays don't.
    if (result.created && this.notifier) {
      const notifier = this.notifier;
      void notifier.startForIncident(incident).catch((error: unknown) => {
        this.log.error(
          { err: error, incidentId: incident.id },
          "notification pipeline failed — SOS response unaffected",
        );
      });
    }

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

  /**
   * Responder action (spec §9, §11): one deliberate step per request —
   * ACCEPT / DECLINE / EN_ROUTE / ARRIVED / WITHDRAW. Only devices that were
   * notified for this incident may respond, and only via legal transitions.
   * The first ACCEPT moves the incident to RESPONDER_ACKNOWLEDGED.
   */
  async respond(
    deviceId: string,
    incidentId: string,
    action: ResponderAction,
  ): Promise<{ incident: SosIncidentRow; responder: IncidentResponderRow }> {
    const incident = await this.db.getIncident(incidentId);
    if (!incident) throw notFound("INCIDENT_NOT_FOUND", "Incident not found");

    if (incident.status === "RESOLVED" || incident.status === "CANCELLED") {
      throw conflict(
        "INCIDENT_CLOSED",
        `Incident is already ${incident.status.toLowerCase()}`,
        { status: incident.status },
      );
    }

    const membership = await this.db.getIncidentResponder(incidentId, deviceId);
    if (!membership) {
      throw forbidden(
        "NOT_A_RESPONDER",
        "You were not notified for this incident",
      );
    }

    const targetStatus = ACTION_TO_STATUS[action];
    assertResponderTransition(membership.status, targetStatus);

    const now = new Date().toISOString();
    const patch: Parameters<Database["updateIncidentResponder"]>[2] = {
      status: targetStatus,
    };
    if (action === "ACCEPT") patch.accepted_at = now;
    if (action === "DECLINE") patch.declined_at = now;
    if (action === "EN_ROUTE") patch.en_route_at = now;
    if (action === "ARRIVED") patch.arrived_at = now;
    if (action === "WITHDRAW") patch.withdrawn_at = now;

    const responder = await this.db.updateIncidentResponder(incidentId, deviceId, patch);

    await this.db.appendResponderEvent({
      incidentId,
      deviceId,
      eventType: `responder.${action.toLowerCase()}`,
      metadata: { fromStatus: membership.status, toStatus: targetStatus },
    });
    await this.db.appendAuditLog({
      deviceId,
      incidentId,
      eventType: "sos.responder_action",
      data: { action, fromStatus: membership.status, toStatus: targetStatus },
    });

    let updatedIncident = incident;
    if (action === "ACCEPT" && incident.status !== "RESPONDER_ACKNOWLEDGED") {
      updatedIncident = await this.markAcknowledged(incident);
    }
    if (action === "DECLINE") {
      await this.markRecipientDeclined(incidentId, deviceId);
    }
    if (action === "WITHDRAW") {
      const notifier = this.notifier;
      if (notifier?.resumeAfterWithdrawal) {
        void notifier.resumeAfterWithdrawal(incidentId).catch((error: unknown) => {
          this.log.error(
            { err: error, incidentId },
            "escalation resume after withdrawal failed",
          );
        });
      }
    }

    this.log.info(
      { incidentId, deviceId, action, fromStatus: membership.status, toStatus: targetStatus },
      "responder action recorded",
    );
    return { incident: updatedIncident, responder };
  }

  /** First ACCEPT: HELP_REQUESTED -> RESPONDER_ACKNOWLEDGED (spec §9). */
  private async markAcknowledged(incident: SosIncidentRow): Promise<SosIncidentRow> {
    let current = incident;
    if (current.status === "ACTIVE") {
      // The async notification pipeline hasn't flipped it yet — an explicit
      // acceptance is stronger, record both transitions honestly.
      assertIncidentTransition(current.status, "HELP_REQUESTED");
      current = await this.db.updateIncident(current.id, { status: "HELP_REQUESTED" });
    }
    if (current.status === "HELP_REQUESTED") {
      assertIncidentTransition(current.status, "RESPONDER_ACKNOWLEDGED");
      current = await this.db.updateIncident(current.id, {
        status: "RESPONDER_ACKNOWLEDGED",
      });
      await this.db.appendAuditLog({
        deviceId: current.device_id,
        incidentId: current.id,
        eventType: "sos.responder_acknowledged",
        data: { note: "first responder accepted" },
      });
      this.log.info({ incidentId: current.id }, "incident: HELP_REQUESTED -> RESPONDER_ACKNOWLEDGED");
    }
    return current;
  }

  /** A declined nearby device marks its call-recipient rows as DECLINED. */
  private async markRecipientDeclined(incidentId: string, deviceId: string): Promise<void> {
    const reference = `device:${deviceId}`;
    const recipients = await this.db.listIncidentRecipients(incidentId);
    for (const recipient of recipients) {
      if (recipient.recipient_type !== "nearby_device") continue;
      if (recipient.recipient_reference !== reference) continue;
      if (recipient.delivery_status === "DECLINED") continue;
      await this.db.updateIncidentRecipient(recipient.id, { delivery_status: "DECLINED" });
    }
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
