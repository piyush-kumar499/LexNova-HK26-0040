import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config/env.js";
import type { IncidentRecipientRow, RecipientType, SosIncidentRow } from "../models/sos.model.js";
import type { CallEventRow, CallStatus } from "../models/vapi.model.js";
import { findOrCreate } from "../middleware/idempotency.js";
import { roundDistance, type NearbyService } from "./nearby.service.js";
import type { Database } from "./supabase.service.js";
import type { CallProviderClient, OutboundCallResult } from "./vapi.service.js";
import type { IncidentNotifier } from "./sos.service.js";

/** A single call target in the escalation chain. */
export interface EscalationTarget {
  recipientType: RecipientType;
  /**
   * Stable identity used in idempotency keys and recipient rows: the phone
   * number for trusted contacts, `device:<uuid>` for nearby devices.
   */
  reference: string;
  /** Destination number actually dialed. */
  toNumber: string;
  distanceM: number | null;
  deviceId?: string;
  label?: string | null;
}

const TERMINAL_FAILURE_STATUSES = new Set<CallStatus>(["NO_ANSWER", "FAILED"]);
const CONNECTED_STATUSES = new Set<CallStatus>(["ANSWERED", "IN_PROGRESS"]);
const IN_FLIGHT_STATUSES = new Set<CallStatus>(["QUEUED", "RINGING"]);

/**
 * Escalation (spec §7, §10). Level 1 calls trusted contacts in priority order;
 * each further level calls nearby devices (Community Responders) with fresh
 * locations inside an increasing radius. A call that never connects — whether
 * reported by a webhook, by the provider at creation time, or by the local
 * watchdog when no event ever arrives — moves the chain to the next recipient.
 * Once a responder accepts, the chain stops. Nothing here ever dials a public
 * emergency number; when every level is exhausted that is said explicitly in
 * the audit trail.
 *
 * Call placement is always two-phase: the call event is recorded (QUEUED)
 * before the provider is invoked, so no call exists without a durable record.
 */
export class EscalationService implements IncidentNotifier {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Database,
    private readonly provider: CallProviderClient,
    private readonly log: FastifyBaseLogger,
    private readonly config: AppConfig,
    private readonly nearby: NearbyService,
  ) {}

  /** Entry point fired right after an incident is created. Never awaited by the request path. */
  async startForIncident(incident: SosIncidentRow): Promise<void> {
    await this.markHelpRequested(incident.id);
    await this.continueChain(incident.id, 1, null);
  }

  /**
   * Called when a call ends unanswered or failed (spec §5.10). Only the most
   * recent attempt at its level may advance the chain — late duplicate
   * webhooks for older attempts must not skip anyone still in flight.
   */
  async handleCallOutcome(callEvent: CallEventRow): Promise<void> {
    if (!callEvent.recipient_reference) return;
    if (!TERMINAL_FAILURE_STATUSES.has(callEvent.status)) return;

    const level = callEvent.level ?? 1;
    const frontier = await this.lastAttemptedReference(callEvent.incident_id, level);
    if (frontier !== callEvent.recipient_reference) {
      this.log.info(
        {
          incidentId: callEvent.incident_id,
          recipient: callEvent.recipient_reference,
          frontier,
        },
        "escalation: stale call outcome — chain already moved on",
      );
      return;
    }

    await this.continueChain(callEvent.incident_id, level, callEvent.recipient_reference);
  }

  /**
   * Boot rehydration (spec §10): resumes incidents that were open when the
   * process last stopped. Idempotent — recipients already attempted are never
   * called twice; in-flight attempts get a fresh watchdog for the remaining
   * slice of the timeout.
   */
  async rehydrateOpenIncidents(): Promise<void> {
    const open = await this.db.listOpenIncidents();
    if (open.length === 0) return;

    this.log.info(
      { count: open.length, incidentIds: open.map((i) => i.id) },
      "escalation: rehydrating open incidents after restart",
    );
    for (const incident of open) {
      try {
        await this.resumeIncident(incident);
      } catch (error) {
        this.log.error(
          { err: error, incidentId: incident.id },
          "escalation: rehydration failed for incident",
        );
      }
    }
  }

  /** Cancels all pending watchdogs — called on server shutdown. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Places one call attempt and records both the call event and the delivery truth. */
  async notifyRecipient(
    incident: SosIncidentRow,
    target: EscalationTarget,
    level: number,
  ): Promise<void> {
    const attempt = 1;
    const idempotencyKey = `incident:${incident.id}:recipient:${target.reference}:level:${level}:attempt:${attempt}`;

    if (target.recipientType === "nearby_device" && target.deviceId !== undefined) {
      await this.nearby.registerNotifiedResponder(
        incident,
        target.deviceId,
        target.distanceM ?? 0,
      );
    }

    const recipient = await this.getOrCreateRecipient(incident.id, target, level);

    const callEvent = await findOrCreate({
      find: () => this.db.findCallEventByIdempotencyKey(idempotencyKey),
      create: () =>
        this.db.insertCallEvent({
          incidentId: incident.id,
          provider: this.provider.provider,
          callReference: null,
          idempotencyKey,
          recipientReference: target.reference,
          level,
          status: "QUEUED",
        }),
      readAfterConflict: () => this.db.findCallEventByIdempotencyKey(idempotencyKey),
    });
    if (!callEvent.created) {
      this.log.info(
        { incidentId: incident.id, idempotencyKey },
        "escalation: call attempt already recorded — skipping duplicate",
      );
      return;
    }

    let result: OutboundCallResult;
    try {
      result = await this.provider.createCall({
        toNumber: target.toNumber,
        incidentId: incident.id,
        recipientReference: target.reference,
        level,
        attempt,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : "call provider failed";
      await this.db.updateCallEvent(callEvent.value.id, {
        status: "FAILED",
        ended_at: new Date().toISOString(),
        ended_reason: reason,
      });
      await this.db.updateIncidentRecipient(recipient.id, { delivery_status: "FAILED" });
      await this.auditAttempt(incident, target, level, {
        outcome: "provider_error",
        mocked: this.provider.mocked,
      });
      this.log.error(
        { err: error, incidentId: incident.id, recipient: target.reference },
        "escalation: call provider failed",
      );
      // The provider is failing: pace the chain through the watchdog instead
      // of dialing every remaining recipient in a tight loop.
      this.scheduleWatchdog(idempotencyKey, incident.id, level, target.reference);
      return;
    }

    await this.db.updateCallEvent(callEvent.value.id, {
      call_reference: result.callReference,
      status: result.status,
      started_at: result.startedAt,
      answered_at: result.answeredAt,
      ended_at: result.endedAt,
      ended_reason: result.endedReason,
      raw_event: result.rawResponse,
    });

    const deliveryStatus = CONNECTED_STATUSES.has(result.status)
      ? ("DELIVERED" as const)
      : IN_FLIGHT_STATUSES.has(result.status)
        ? // Providers report queued/ringing at creation time; the webhook (or
          // the watchdog) resolves the truth later. Never claim more than confirmed.
          ("ATTEMPTED" as const)
        : ("FAILED" as const);
    await this.db.updateIncidentRecipient(recipient.id, {
      delivery_status: deliveryStatus,
      provider_reference: result.callReference,
    });

    await this.auditAttempt(incident, target, level, {
      outcome: result.status,
      provider: result.provider,
      mocked: this.provider.mocked,
    });

    this.log.info(
      {
        incidentId: incident.id,
        recipient: target.reference,
        provider: result.provider,
        mocked: this.provider.mocked,
        status: result.status,
        level,
      },
      "escalation: call attempt recorded",
    );

    if (TERMINAL_FAILURE_STATUSES.has(result.status)) {
      // The provider already reported the outcome (mock provider, or an
      // immediate busy/failure response) — move on now. Duplicate webhooks
      // for this attempt are absorbed by the frontier guard.
      await this.continueChain(incident.id, level, target.reference);
      return;
    }
    if (IN_FLIGHT_STATUSES.has(result.status)) {
      this.scheduleWatchdog(idempotencyKey, incident.id, level, target.reference);
    }
    // ANSWERED / IN_PROGRESS: a human connected — the chain pauses here.
  }

  // -------------------------------------------------------------------------
  // Chain mechanics
  // -------------------------------------------------------------------------

  /**
   * Notifies the next not-yet-attempted recipient at `level` (starting after
   * `afterReference` when given), or rolls over to the next level, or records
   * exhaustion. Every step is idempotent, so re-entry after a restart or a
   * duplicate webhook converges on the same state.
   */
  private async continueChain(
    incidentId: string,
    level: number,
    afterReference: string | null,
  ): Promise<void> {
    const incident = await this.db.getIncident(incidentId);
    if (!incident) return;
    if (!(await this.shouldContinueEscalation(incident))) return;

    if (level > this.config.escalation.maxLevel) {
      await this.markExhausted(incident);
      return;
    }
    if (incident.status === "ACTIVE") {
      await this.markHelpRequested(incidentId);
    }

    const targets = await this.recipientsForLevel(incident, level);
    if (targets.length === 0) {
      await this.auditNoRecipients(incident, level);
      return this.continueChain(incidentId, level + 1, null);
    }

    const attempted = await this.attemptedReferences(incidentId);
    const start =
      afterReference === null
        ? 0
        : Math.max(0, targets.findIndex((t) => t.reference === afterReference) + 1);
    const next = targets.slice(start).find((t) => !attempted.has(t.reference));
    if (!next) return this.continueChain(incidentId, level + 1, null);

    if (incident.escalation_level < level) {
      await this.db.updateIncident(incidentId, { escalation_level: level });
    }
    await this.notifyRecipient(incident, next, level);
  }

  private async resumeIncident(incident: SosIncidentRow): Promise<void> {
    if (incident.status === "ACTIVE") {
      // Interrupted before the notification pipeline even flipped the status.
      await this.startForIncident(incident);
      return;
    }
    if (!(await this.shouldContinueEscalation(incident))) return;

    const level = incident.escalation_level >= 1 ? incident.escalation_level : 1;
    const eventsAtLevel = (await this.db.listCallEvents(incident.id)).filter(
      (event) => (event.level ?? 1) === level,
    );
    const last = eventsAtLevel[eventsAtLevel.length - 1];
    if (!last || !last.recipient_reference) {
      await this.continueChain(incident.id, level, null);
      return;
    }

    const connected =
      CONNECTED_STATUSES.has(last.status) ||
      (last.status === "ENDED" && last.answered_at !== null);
    if (connected) return; // a human connected before the restart — chain stays paused

    if (IN_FLIGHT_STATUSES.has(last.status) && last.idempotency_key) {
      const elapsedMs = Date.now() - Date.parse(last.created_at);
      const remainingMs = Math.max(this.timeoutMs() - elapsedMs, 0);
      this.scheduleWatchdog(
        last.idempotency_key,
        incident.id,
        level,
        last.recipient_reference,
        remainingMs,
      );
      this.log.info(
        { incidentId: incident.id, recipient: last.recipient_reference, remainingMs },
        "escalation: re-armed watchdog for an in-flight attempt",
      );
      return;
    }

    await this.continueChain(incident.id, level, last.recipient_reference);
  }

  /** Recipients for a level, in dial order. Level 1 = contacts; ≥2 = nearby devices. */
  private async recipientsForLevel(
    incident: SosIncidentRow,
    level: number,
  ): Promise<EscalationTarget[]> {
    if (level <= 1) {
      const contacts = await this.db.listTrustedContacts(incident.device_id);
      return contacts.map((contact) => ({
        recipientType: "trusted_contact" as const,
        reference: contact.phone_number,
        toNumber: contact.phone_number,
        distanceM: null,
        label: contact.contact_name,
      }));
    }
    return this.nearbyTargets(incident, level);
  }

  private async nearbyTargets(
    incident: SosIncidentRow,
    level: number,
  ): Promise<EscalationTarget[]> {
    if (incident.latitude === null || incident.longitude === null) return [];

    const found = await this.db.findNearbyDevices({
      latitude: incident.latitude,
      longitude: incident.longitude,
      radiusMeters: this.radiusForLevel(level),
      maxResults: this.config.nearby.maxResults,
      excludeDeviceId: incident.device_id,
    });

    // Numbers already dialed (or queued to dial) at another level must not be
    // called again because their owner's device happens to be nearby.
    const trusted = await this.db.listTrustedContacts(incident.device_id);
    const seenPhones = new Set(trusted.map((contact) => contact.phone_number));
    const victim = await this.db.getDeviceByDeviceId(incident.device_id);
    if (victim?.phone_number) seenPhones.add(victim.phone_number);

    const targets: EscalationTarget[] = [];
    for (const device of found) {
      const row = await this.db.getDeviceByDeviceId(device.deviceId);
      if (!row || !row.phone_number) continue; // no phone = reachable only via polling
      if (seenPhones.has(row.phone_number)) continue;
      seenPhones.add(row.phone_number);
      targets.push({
        recipientType: "nearby_device",
        reference: `device:${row.device_id}`,
        toNumber: row.phone_number,
        distanceM: device.distanceM,
        deviceId: row.device_id,
        label: row.display_name,
      });
    }
    return targets;
  }

  /**
   * Watchdog for an attempt whose outcome never arrived (e.g. the webhook URL
   * was stale). A connected call is never disturbed; anything else moves the
   * chain on after the configured timeout.
   */
  private scheduleWatchdog(
    idempotencyKey: string,
    incidentId: string,
    level: number,
    reference: string,
    delayMs = this.timeoutMs(),
  ): void {
    const existing = this.timers.get(idempotencyKey);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(idempotencyKey);
      void this.onAttemptTimeout(idempotencyKey, incidentId, level, reference).catch(
        (error: unknown) => {
          this.log.error(
            { err: error, incidentId, recipient: reference },
            "escalation: attempt timeout handler failed",
          );
        },
      );
    }, delayMs);
    timer.unref();
    this.timers.set(idempotencyKey, timer);
  }

  private async onAttemptTimeout(
    idempotencyKey: string,
    incidentId: string,
    level: number,
    reference: string,
  ): Promise<void> {
    const callEvent = await this.db.findCallEventByIdempotencyKey(idempotencyKey);
    if (!callEvent) return;
    const connected =
      CONNECTED_STATUSES.has(callEvent.status) ||
      (callEvent.status === "ENDED" && callEvent.answered_at !== null);
    if (connected) return;

    const frontier = await this.lastAttemptedReference(incidentId, level);
    if (frontier !== reference) return; // the chain already moved on

    const incident = await this.db.getIncident(incidentId);
    if (!incident) return;
    if (!(await this.shouldContinueEscalation(incident))) return;

    await this.db.appendAuditLog({
      deviceId: incident.device_id,
      incidentId,
      eventType: "escalation.call_timeout",
      data: {
        recipient: reference,
        level,
        lastStatus: callEvent.status,
        timeoutSeconds: this.config.escalation.timeoutSeconds,
      },
    });
    this.log.warn(
      { incidentId, recipient: reference, level, lastStatus: callEvent.status },
      "escalation: call attempt timed out without connecting — moving on",
    );

    await this.continueChain(incidentId, level, reference);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * The chain stops when the incident is closed or when any responder has
   * accepted (help is on the way — calling more people would not help).
   */
  private async shouldContinueEscalation(incident: SosIncidentRow): Promise<boolean> {
    if (
      incident.status !== "ACTIVE" &&
      incident.status !== "HELP_REQUESTED" &&
      incident.status !== "RESPONDER_ACKNOWLEDGED"
    ) {
      return false;
    }
    const responders = await this.db.listIncidentResponders(incident.id);
    const helpOnTheWay = responders.some(
      (row) => row.status === "ACCEPTED" || row.status === "EN_ROUTE" || row.status === "ARRIVED",
    );
    if (helpOnTheWay) {
      this.log.info(
        { incidentId: incident.id },
        "escalation: a responder already accepted — chain stops",
      );
      return false;
    }
    return true;
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

  private async markExhausted(incident: SosIncidentRow): Promise<void> {
    await this.db.appendAuditLog({
      deviceId: incident.device_id,
      incidentId: incident.id,
      eventType: "escalation.exhausted",
      data: {
        maxLevel: this.config.escalation.maxLevel,
        note: "no automatic emergency-service dispatch is attempted; nearby devices can still discover this incident by polling",
      },
    });
    this.log.warn(
      { incidentId: incident.id, maxLevel: this.config.escalation.maxLevel },
      "escalation: all levels exhausted",
    );
  }

  private async auditNoRecipients(incident: SosIncidentRow, level: number): Promise<void> {
    const isContactsLevel = level <= 1;
    await this.db.appendAuditLog({
      deviceId: incident.device_id,
      incidentId: incident.id,
      eventType: isContactsLevel ? "escalation.no_recipients" : "escalation.level_no_recipients",
      data: isContactsLevel
        ? { note: "no trusted contacts configured" }
        : { level, radiusMeters: this.radiusForLevel(level) },
    });
    this.log.info(
      { incidentId: incident.id, level },
      "escalation: no recipients at this level",
    );
  }

  private async getOrCreateRecipient(
    incidentId: string,
    target: EscalationTarget,
    level: number,
  ): Promise<IncidentRecipientRow> {
    const lookup = (): Promise<IncidentRecipientRow | null> =>
      this.db.getIncidentRecipient({
        incidentId,
        recipientType: target.recipientType,
        recipientReference: target.reference,
        level,
      });
    const { value } = await findOrCreate({
      find: lookup,
      create: () =>
        this.db.insertIncidentRecipient({
          incidentId,
          recipientType: target.recipientType,
          recipientReference: target.reference,
          level,
          deliveryStatus: "PENDING",
        }),
      readAfterConflict: lookup,
    });
    return value;
  }

  private async attemptedReferences(incidentId: string): Promise<Set<string>> {
    const events = await this.db.listCallEvents(incidentId);
    return new Set(
      events
        .map((event) => event.recipient_reference)
        .filter((reference): reference is string => reference !== null),
    );
  }

  private async lastAttemptedReference(incidentId: string, level: number): Promise<string | null> {
    const events = (await this.db.listCallEvents(incidentId)).filter(
      (event) => (event.level ?? 1) === level,
    );
    const last = events[events.length - 1];
    return last?.recipient_reference ?? null;
  }

  private async auditAttempt(
    incident: SosIncidentRow,
    target: EscalationTarget,
    level: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.db.appendAuditLog({
      deviceId: incident.device_id,
      incidentId: incident.id,
      eventType: "escalation.call_attempted",
      data: {
        recipientType: target.recipientType,
        recipient: target.reference,
        level,
        attempt: 1,
        ...(target.distanceM !== null ? { distanceApproxM: roundDistance(target.distanceM) } : {}),
        ...data,
      },
    });
  }

  private timeoutMs(): number {
    return this.config.escalation.timeoutSeconds * 1000;
  }

  /** Level ≥2 widens around the incident: level 2 = 1×radius, level 3 = 2×radius, … */
  private radiusForLevel(level: number): number {
    return this.config.nearby.radiusMeters * (level - 1);
  }
}
