import type { FastifyBaseLogger } from "fastify";
import type { TrustedContactRow } from "../models/device.model.js";
import type { SosIncidentRow } from "../models/sos.model.js";
import type { CallEventRow } from "../models/vapi.model.js";
import type { Database } from "./supabase.service.js";
import type { CallProviderClient, OutboundCallResult } from "./vapi.service.js";
import type { IncidentNotifier } from "./sos.service.js";

/**
 * Escalation (spec §7, §10), first pass: on SOS, notify trusted contacts in
 * priority order through the call provider. Later steps extend this with
 * no-answer chains, radius expansion and boot rehydration.
 *
 * Every attempt is recorded before it is made (call_events, QUEUED) and its
 * outcome updated afterwards. Delivery, acknowledgement and failure are
 * separate facts — a placed call never implies an acknowledgement.
 */
export class EscalationService implements IncidentNotifier {
  constructor(
    private readonly db: Database,
    private readonly provider: CallProviderClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Entry point fired right after an incident is created. Never awaited by the request path. */
  async startForIncident(incident: SosIncidentRow): Promise<void> {
    await this.markHelpRequested(incident.id);

    const contacts = await this.db.listTrustedContacts(incident.device_id);
    if (contacts.length === 0) {
      await this.db.appendAuditLog({
        deviceId: incident.device_id,
        incidentId: incident.id,
        eventType: "escalation.no_recipients",
        data: { note: "no trusted contacts configured" },
      });
      this.log.info({ incidentId: incident.id }, "escalation: no trusted contacts to notify");
      return;
    }

    await this.notifyContact(incident, contacts[0]!, { level: 1, attempt: 1 });
  }

  private async markHelpRequested(incidentId: string): Promise<void> {
    const fresh = await this.db.getIncident(incidentId);
    if (!fresh || fresh.status !== "ACTIVE") return;
    await this.db.updateIncident(incidentId, {
      status: "HELP_REQUESTED",
      escalation_level: 1,
    });
    this.log.info({ incidentId }, "incident: ACTIVE -> HELP_REQUESTED");
  }

  /** Places one call attempt and records both the call event and the delivery truth. */
  async notifyContact(
    incident: SosIncidentRow,
    contact: TrustedContactRow,
    options: { level: number; attempt: number },
  ): Promise<void> {
    const idempotencyKey = `incident:${incident.id}:recipient:${contact.phone_number}:level:${options.level}:attempt:${options.attempt}`;

    const existing = await this.db.findCallEventByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.log.info(
        { incidentId: incident.id, idempotencyKey },
        "escalation: call attempt already recorded — skipping duplicate",
      );
      return;
    }

    let recipient = await this.db.getIncidentRecipient({
      incidentId: incident.id,
      recipientType: "trusted_contact",
      recipientReference: contact.phone_number,
      level: options.level,
    });
    if (!recipient) {
      recipient = await this.db.insertIncidentRecipient({
        incidentId: incident.id,
        recipientType: "trusted_contact",
        recipientReference: contact.phone_number,
        level: options.level,
        deliveryStatus: "PENDING",
      });
    }

    const callEvent = await this.db.insertCallEvent({
      incidentId: incident.id,
      provider: this.provider.provider,
      callReference: null,
      idempotencyKey,
      recipientReference: contact.phone_number,
      level: options.level,
      status: "QUEUED",
    });

    let result: OutboundCallResult;
    try {
      result = await this.provider.createCall({
        toNumber: contact.phone_number,
        incidentId: incident.id,
        recipientReference: contact.phone_number,
        level: options.level,
        attempt: options.attempt,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : "call provider failed";
      await this.db.updateCallEvent(callEvent.id, {
        status: "FAILED",
        ended_at: new Date().toISOString(),
        ended_reason: reason,
      });
      await this.db.updateIncidentRecipient(recipient.id, { delivery_status: "FAILED" });
      await this.auditAttempt(incident, contact, options, {
        outcome: "provider_error",
        mocked: this.provider.mocked,
      });
      this.log.error(
        { err: error, incidentId: incident.id, recipient: contact.phone_number },
        "escalation: call provider failed",
      );
      return;
    }

    await this.db.updateCallEvent(callEvent.id, {
      call_reference: result.callReference,
      status: result.status,
      started_at: result.startedAt,
      answered_at: result.answeredAt,
      ended_at: result.endedAt,
      ended_reason: result.endedReason,
      raw_event: result.rawResponse,
    });

    const connected = result.status === "ANSWERED" || result.status === "IN_PROGRESS";
    const deliveryStatus = connected
      ? ("DELIVERED" as const)
      : result.status === "QUEUED" || result.status === "RINGING"
        ? // Real providers report queued/ringing at creation time; the
          // webhook later resolves delivery. Never claim more than confirmed.
          ("ATTEMPTED" as const)
        : ("FAILED" as const);
    await this.db.updateIncidentRecipient(recipient.id, {
      delivery_status: deliveryStatus,
      provider_reference: result.callReference,
    });

    await this.auditAttempt(incident, contact, options, {
      outcome: result.status,
      provider: result.provider,
      mocked: this.provider.mocked,
    });

    this.log.info(
      {
        incidentId: incident.id,
        recipient: contact.phone_number,
        provider: result.provider,
        mocked: this.provider.mocked,
        status: result.status,
      },
      "escalation: call attempt recorded",
    );
  }

  /**
   * Called when a call ends unanswered or failed (spec §5.10): move to the
   * next trusted contact in priority order. When the contact list is
   * exhausted, the incident is recorded as needing the next escalation level
   * (radius expansion), which the nearby-dispatch step consumes.
   */
  async handleCallOutcome(callEvent: CallEventRow): Promise<void> {
    if (callEvent.status !== "NO_ANSWER" && callEvent.status !== "FAILED") return;

    const incident = await this.db.getIncident(callEvent.incident_id);
    if (!incident) return;
    if (incident.status === "RESOLVED" || incident.status === "CANCELLED") {
      this.log.info(
        { incidentId: incident.id, status: incident.status },
        "escalation: call ended but incident is already closed — no further action",
      );
      return;
    }

    const contacts = await this.db.listTrustedContacts(incident.device_id);
    const currentIndex = callEvent.recipient_reference
      ? contacts.findIndex((c) => c.phone_number === callEvent.recipient_reference)
      : -1;
    const next = currentIndex >= 0 ? contacts[currentIndex + 1] : undefined;

    if (!next) {
      await this.db.appendAuditLog({
        deviceId: incident.device_id,
        incidentId: incident.id,
        eventType: "escalation.contacts_exhausted",
        data: {
          level: callEvent.level ?? 1,
          attemptedRecipient: callEvent.recipient_reference,
          nextStep: "expand radius to nearby devices",
        },
      });
      this.log.warn(
        { incidentId: incident.id, level: callEvent.level ?? 1 },
        "escalation: all trusted contacts attempted — next level is radius expansion",
      );
      return;
    }

    this.log.info(
      {
        incidentId: incident.id,
        previousRecipient: callEvent.recipient_reference,
        nextRecipient: next.phone_number,
      },
      "escalation: moving to the next trusted contact",
    );
    await this.notifyContact(incident, next, { level: callEvent.level ?? 1, attempt: 1 });
  }

  private async auditAttempt(
    incident: SosIncidentRow,
    contact: TrustedContactRow,
    options: { level: number; attempt: number },
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.db.appendAuditLog({
      deviceId: incident.device_id,
      incidentId: incident.id,
      eventType: "escalation.call_attempted",
      data: {
        recipientType: "trusted_contact",
        recipient: contact.phone_number,
        level: options.level,
        attempt: options.attempt,
        ...data,
      },
    });
  }
}
