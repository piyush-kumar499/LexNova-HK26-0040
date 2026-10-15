import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig, MockVapiOutcome } from "../config/env.js";
import { isVapiFullyConfigured, missingVapiVars } from "../config/env.js";
import type { DeliveryStatus } from "../models/sos.model.js";
import type {
  CallEventRow,
  CallProvider,
  CallStatus,
  VapiWebhookEventType,
} from "../models/vapi.model.js";
import { VAPI_WEBHOOK_EVENT_TYPES } from "../models/vapi.model.js";
import { hmacSha256Hex, safeEqual } from "../utils/crypto.js";
import type { Database } from "./supabase.service.js";
import type { EscalationService } from "./escalation.service.js";

export interface CreateOutboundCallRequest {
  toNumber: string;
  incidentId: string;
  recipientReference: string;
  level: number;
  attempt: number;
}

export interface OutboundCallResult {
  provider: CallProvider;
  callReference: string;
  status: CallStatus;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  rawResponse: Record<string, unknown> | null;
}

export interface CallProviderClient {
  readonly provider: CallProvider;
  /** True when no real call is placed — logs must say so (spec: never pretend). */
  readonly mocked: boolean;
  createCall(request: CreateOutboundCallRequest): Promise<OutboundCallResult>;
}

// Vapi CallStatus / CallEndedReason values below are taken from the official
// server SDK (VapiAI/server-sdk-typescript). We normalize them into our own
// CallStatus enum; the untouched payload is kept in call_events.raw_event.
const NO_ANSWER_REASONS = new Set([
  "customer-did-not-answer",
  "customer-busy",
  "voicemail",
  "call.forwarding.no-answer",
]);

const FAILURE_PREFIXES = [
  "call.start.error",
  "call-start-error-",
  "assistant-request-",
  "twilio-failed",
  "twilio-reported-customer-misdialed",
];

export function normalizeVapiCallStatus(
  vapiStatus: string,
  endedReason: string | null,
): CallStatus {
  switch (vapiStatus) {
    case "scheduled":
    case "queued":
      return "QUEUED";
    case "ringing":
      return "RINGING";
    case "in-progress":
    case "forwarding":
      return "IN_PROGRESS";
    case "not-found":
    case "deletion-failed":
      return "FAILED";
    case "ended": {
      if (!endedReason) return "ENDED";
      if (NO_ANSWER_REASONS.has(endedReason)) return "NO_ANSWER";
      if (FAILURE_PREFIXES.some((prefix) => endedReason.startsWith(prefix))) {
        return "FAILED";
      }
      // Anything else reached the callee and then ended normally.
      return "ANSWERED";
    }
    default:
      return "FAILED";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Real provider: outbound calls through the Vapi REST API. Request shape
 * follows the official SDK (CreateCallDto): POST {base}/call with
 * { assistantId, phoneNumberId, customer: { number } } and a bearer private
 * key. The assistant's script lives in the Vapi dashboard, not here.
 */
export class VapiRestClient implements CallProviderClient {
  readonly provider = "vapi" as const;
  readonly mocked = false;

  constructor(
    private readonly config: AppConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  async createCall(request: CreateOutboundCallRequest): Promise<OutboundCallResult> {
    const { privateKey, phoneNumberId, assistantId, apiBaseUrl } = this.config.vapi;
    if (!privateKey || !phoneNumberId || !assistantId) {
      throw new Error(
        "Vapi is not fully configured — provider factory should have selected the mock",
      );
    }

    const response = await fetch(`${apiBaseUrl}/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${privateKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: request.toNumber },
        name: `SOS ${request.incidentId}`,
        assistantOverrides: {
          variableValues: {
            incidentId: request.incidentId,
            escalationLevel: request.level,
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!response.ok || !payload || typeof payload.id !== "string") {
      const detail = payload
        ? JSON.stringify(payload).slice(0, 500)
        : `HTTP ${response.status}`;
      throw new Error(`Vapi create-call failed (${response.status}): ${detail}`);
    }

    const vapiStatus = typeof payload.status === "string" ? payload.status : "queued";
    const endedReason = typeof payload.endedReason === "string" ? payload.endedReason : null;

    this.log.info(
      { callReference: payload.id, incidentId: request.incidentId, vapiStatus },
      "vapi: outbound call created",
    );

    return {
      provider: "vapi",
      callReference: payload.id,
      status: normalizeVapiCallStatus(vapiStatus, endedReason),
      startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
      // The Call object has no answeredAt; connection time arrives via webhook.
      answeredAt: null,
      endedAt: typeof payload.endedAt === "string" ? payload.endedAt : null,
      endedReason,
      rawResponse: payload,
    };
  }
}

/**
 * Development fallback (spec §7): simulates the configured outcome. Every
 * call in this mode is logged loudly as MOCKED and recorded with
 * provider="mock" — never presented as a real call.
 */
export class MockVapiClient implements CallProviderClient {
  readonly provider = "mock" as const;
  readonly mocked = true;

  constructor(
    private readonly outcome: MockVapiOutcome,
    private readonly log: FastifyBaseLogger,
  ) {}

  async createCall(request: CreateOutboundCallRequest): Promise<OutboundCallResult> {
    const now = new Date().toISOString();

    this.log.warn(
      {
        incidentId: request.incidentId,
        recipient: request.recipientReference,
        level: request.level,
        simulatedOutcome: this.outcome,
      },
      "VAPI MOCK: call is MOCKED — no real call was placed",
    );

    const base = {
      provider: "mock" as const,
      callReference: `mock-${randomUUID()}`,
      startedAt: now,
      rawResponse: { mock: true, simulatedOutcome: this.outcome },
    };

    switch (this.outcome) {
      case "answered":
        return {
          ...base,
          status: "ANSWERED",
          answeredAt: now,
          endedAt: now,
          endedReason: "mock-simulated-answer",
        };
      case "silent":
        return {
          ...base,
          status: "ANSWERED",
          answeredAt: now,
          endedAt: null,
          endedReason: "mock-silent-line",
        };
      case "no-answer":
        return {
          ...base,
          status: "NO_ANSWER",
          answeredAt: null,
          endedAt: now,
          endedReason: "customer-did-not-answer",
        };
    }
  }
}

/**
 * Real Vapi only when private key + phone number + assistant are all present;
 * otherwise the mock provider, with a warning listing exactly what is missing.
 */
export function createCallProvider(
  config: AppConfig,
  log: FastifyBaseLogger,
): CallProviderClient {
  if (isVapiFullyConfigured(config)) {
    return new VapiRestClient(config, log);
  }
  log.warn(
    { missing: missingVapiVars(config).join(", ") || "(none listed)" },
    "Vapi is not fully configured — using the MOCK call provider: no real calls will be placed",
  );
  return new MockVapiClient(config.mockVapiOutcome, log);
}

// ---------------------------------------------------------------------------
// Webhook verification and normalization (spec §5.10)
// ---------------------------------------------------------------------------

/**
 * Verifies an incoming webhook against VAPI_WEBHOOK_SECRET. Accepts, in order:
 *  1. x-vapi-signature: HMAC-SHA256(secret, raw body), hex (optionally "sha256=" prefixed)
 *  2. authorization: Bearer <secret> — a documented Vapi webhook auth method
 *  3. x-vapi-secret: <secret> — the documented legacy Vapi header
 * All comparisons are constant-time.
 */
export function verifyVapiWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secret: string,
): boolean {
  const header = (name: string): string | null => {
    const value = headers[name];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] ?? null;
    return null;
  };

  const signature = header("x-vapi-signature");
  if (signature) {
    const provided = (
      signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature
    ).toLowerCase();
    return safeEqual(hmacSha256Hex(secret, rawBody), provided);
  }

  const authorization = header("authorization");
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    if (safeEqual(secret, authorization.slice("bearer ".length))) return true;
  }

  const apiSecret = header("x-vapi-secret");
  if (apiSecret && safeEqual(secret, apiSecret)) return true;

  return false;
}

export interface NormalizedWebhookEvent {
  eventType: VapiWebhookEventType;
  callReference: string | null;
  status: CallStatus | null;
  endedReason: string | null;
  recordingUrl: string | null;
  transcript: string | null;
  /** True when the payload carries the complete transcript (end-of-call-report). */
  transcriptIsFull: boolean;
  startedAt: string | null;
  endedAt: string | null;
  raw: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function endedCallEventType(endedReason: string | null): VapiWebhookEventType {
  if (!endedReason) return "call.ended";
  if (NO_ANSWER_REASONS.has(endedReason)) return "call.no-answer";
  if (FAILURE_PREFIXES.some((prefix) => endedReason.startsWith(prefix))) {
    return "call.failed";
  }
  return "call.ended";
}

/**
 * Maps the provider's webhook payload into our normalized event. Understands
 * the documented envelope { message: { type, ... } } with message types
 * "status-update", "end-of-call-report" and "transcript" (field names from
 * the official Vapi server SDK), plus direct normalized events
 * ({ type: "call.answered", callReference, ... }) used by tests and tooling.
 * Returns null for anything unrecognizable — the caller quarantines it.
 */
export function normalizeVapiWebhookEvent(
  body: Record<string, unknown>,
): NormalizedWebhookEvent | null {
  const message = asRecord(body.message) ?? body;
  const type = asString(message.type);
  if (!type) return null;

  const call = asRecord(message.call);
  const callReference = (call ? asString(call.id) : null) ?? asString(message.callReference);
  const artifact = asRecord(message.artifact);

  if ((VAPI_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)) {
    const providerStatus = asString(message.status);
    return {
      eventType: type as VapiWebhookEventType,
      callReference,
      status: providerStatus
        ? normalizeVapiCallStatus(providerStatus, asString(message.endedReason))
        : null,
      endedReason: asString(message.endedReason),
      recordingUrl:
        asString(message.recordingUrl) ??
        (artifact ? asString(artifact.recordingUrl) : null),
      transcript: asString(message.transcript),
      transcriptIsFull: message.transcriptIsFull === true,
      startedAt: asString(message.startedAt),
      endedAt: asString(message.endedAt),
      raw: body,
    };
  }

  switch (type) {
    case "status-update": {
      const providerStatus = asString(message.status) ?? "";
      const endedReason = asString(message.endedReason);
      let eventType: VapiWebhookEventType;
      if (providerStatus === "queued" || providerStatus === "scheduled" || providerStatus === "ringing") {
        eventType = "call.started";
      } else if (providerStatus === "in-progress" || providerStatus === "forwarding") {
        eventType = "call.answered";
      } else if (providerStatus === "ended") {
        eventType = endedCallEventType(endedReason);
      } else {
        eventType = "call.failed";
      }
      return {
        eventType,
        callReference,
        status: normalizeVapiCallStatus(providerStatus, endedReason),
        endedReason,
        recordingUrl: artifact ? asString(artifact.recordingUrl) : null,
        transcript: null,
        transcriptIsFull: false,
        startedAt: null,
        endedAt: null,
        raw: body,
      };
    }
    case "end-of-call-report": {
      const endedReason = asString(message.endedReason);
      return {
        eventType: endedCallEventType(endedReason),
        callReference,
        status: normalizeVapiCallStatus("ended", endedReason),
        endedReason,
        recordingUrl: artifact ? asString(artifact.recordingUrl) : null,
        transcript: artifact ? asString(artifact.transcript) : null,
        transcriptIsFull: true,
        startedAt: asString(message.startedAt),
        endedAt: asString(message.endedAt),
        raw: body,
      };
    }
    case "transcript": {
      const transcriptType = asString(message.transcriptType);
      // "final" means this segment's text is settled (vs "partial" interim
      // text); it is still one segment, not the full transcript. Partials are
      // not stored — they get superseded by their final version.
      const isFinalSegment = transcriptType === "final";
      return {
        eventType: "transcript.ready",
        callReference,
        status: null,
        endedReason: null,
        recordingUrl: null,
        transcript: isFinalSegment ? asString(message.transcript) : null,
        transcriptIsFull: false,
        startedAt: null,
        endedAt: null,
        raw: body,
      };
    }
    default:
      return null;
  }
}

/**
 * Applies normalized webhook events to call_events / incident_evidence and
 * drives the next escalation step on unanswered calls. Runs in the background
 * after the webhook was acknowledged; every failure is logged, never rethrown
 * into the request path.
 */
export class VapiWebhookService {
  constructor(
    private readonly db: Database,
    private readonly escalation: EscalationService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async process(body: Record<string, unknown>): Promise<void> {
    const event = normalizeVapiWebhookEvent(body);
    if (!event) {
      this.log.warn({ bodyKeys: Object.keys(body) }, "vapi webhook: unrecognized payload — ignored");
      return;
    }

    if (!event.callReference) {
      this.log.warn(
        { eventType: event.eventType },
        "vapi webhook: no call reference — cannot attribute, ignored",
      );
      return;
    }

    const callEvent = await this.db.findCallEventByReference(event.callReference);
    if (!callEvent) {
      // Not attributable to any incident we dispatched — quarantine, never
      // guess a different incident (spec §10.2).
      this.log.warn(
        { callReference: event.callReference, eventType: event.eventType },
        "vapi webhook: unknown call reference — quarantined",
      );
      await this.db.appendAuditLog({
        deviceId: null,
        incidentId: null,
        eventType: "vapi.webhook_unmatched",
        data: { eventType: event.eventType, callReference: event.callReference },
      });
      return;
    }

    const now = new Date().toISOString();
    let updated: CallEventRow | null = null;

    switch (event.eventType) {
      case "call.started":
        updated = await this.db.updateCallEvent(callEvent.id, {
          status: event.status ?? "QUEUED",
          started_at: callEvent.started_at ?? now,
        });
        break;
      case "call.answered":
        updated = await this.db.updateCallEvent(callEvent.id, {
          status: event.status ?? "IN_PROGRESS",
          answered_at: callEvent.answered_at ?? now,
          started_at: callEvent.started_at ?? event.startedAt ?? now,
        });
        break;
      case "call.ended":
      case "call.no-answer":
      case "call.failed":
        updated = await this.db.updateCallEvent(callEvent.id, {
          status:
            event.status ??
            (event.eventType === "call.no-answer"
              ? "NO_ANSWER"
              : event.eventType === "call.failed"
                ? "FAILED"
                : "ENDED"),
          ended_at: event.endedAt ?? now,
          ended_reason: event.endedReason ?? callEvent.ended_reason,
        });
        break;
      case "recording.ready":
      case "transcript.ready":
        updated = callEvent; // artifacts are attached below
        break;
    }

    const current = updated ?? callEvent;

    if (event.recordingUrl) {
      await this.attachRecording(current, event.recordingUrl);
    }
    if (event.transcript) {
      await this.attachTranscript(
        current.id,
        current.transcript,
        event.transcript,
        event.transcriptIsFull,
      );
    }

    await this.syncRecipientDelivery(current);

    await this.db.appendAuditLog({
      deviceId: null,
      incidentId: callEvent.incident_id,
      eventType: "vapi.webhook_processed",
      data: { eventType: event.eventType, callReference: event.callReference },
    });

    this.log.info(
      { eventType: event.eventType, callReference: event.callReference, incidentId: callEvent.incident_id },
      "vapi webhook processed",
    );

    if (current.status === "NO_ANSWER" || current.status === "FAILED") {
      await this.escalation.handleCallOutcome(current);
    }
  }

  /** Stores the provider recording reference on the call event and as evidence. */
  private async attachRecording(callEvent: CallEventRow, recordingUrl: string): Promise<void> {
    await this.db.updateCallEvent(callEvent.id, { recording_ref: recordingUrl });

    const existing = await this.db.listIncidentEvidence(callEvent.incident_id);
    if (existing.some((e) => e.kind === "call_recording" && e.storage_ref === recordingUrl)) {
      return;
    }
    await this.db.insertIncidentEvidence({
      incidentId: callEvent.incident_id,
      kind: "call_recording",
      storageRef: recordingUrl,
      mediaType: null,
      capturedAt: callEvent.started_at,
    });
    this.log.info(
      { incidentId: callEvent.incident_id, callReference: callEvent.call_reference },
      "recording reference stored as evidence",
    );
  }

  private async attachTranscript(
    callEventId: string,
    existingTranscript: string | null,
    incoming: string,
    isFull: boolean,
  ): Promise<void> {
    let next: string;
    if (isFull || !existingTranscript) {
      next = incoming;
    } else if (existingTranscript.includes(incoming)) {
      next = existingTranscript; // webhook retries must not duplicate segments
    } else {
      next = `${existingTranscript}\n${incoming}`;
    }
    await this.db.updateCallEvent(callEventId, { transcript: next });
  }

  /** Mirrors the call's progress into the incident_recipients delivery truth. */
  private async syncRecipientDelivery(callEvent: CallEventRow): Promise<void> {
    if (!callEvent.recipient_reference) return;

    // Calls target trusted contacts (reference = phone) or nearby devices
    // (reference = device:<uuid>); find whichever recipient row matches.
    let recipient = await this.db.getIncidentRecipient({
      incidentId: callEvent.incident_id,
      recipientType: "trusted_contact",
      recipientReference: callEvent.recipient_reference,
      level: callEvent.level ?? 1,
    });
    if (!recipient) {
      recipient = await this.db.getIncidentRecipient({
        incidentId: callEvent.incident_id,
        recipientType: "nearby_device",
        recipientReference: callEvent.recipient_reference,
        level: callEvent.level ?? 1,
      });
    }
    if (!recipient) return;

    let delivery: DeliveryStatus | null = null;
    switch (callEvent.status) {
      case "ANSWERED":
      case "IN_PROGRESS":
        delivery = "DELIVERED";
        break;
      case "NO_ANSWER":
      case "FAILED":
        delivery = "FAILED";
        break;
      case "QUEUED":
      case "RINGING":
        delivery = recipient.delivery_status === "PENDING" ? "ATTEMPTED" : null;
        break;
      case "ENDED":
        delivery = callEvent.answered_at ? "DELIVERED" : "FAILED";
        break;
    }

    if (delivery && delivery !== recipient.delivery_status) {
      await this.db.updateIncidentRecipient(recipient.id, { delivery_status: delivery });
    }
  }
}
