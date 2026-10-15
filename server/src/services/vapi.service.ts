import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig, MockVapiOutcome } from "../config/env.js";
import { isVapiFullyConfigured, missingVapiVars } from "../config/env.js";
import type { CallProvider, CallStatus } from "../models/vapi.model.js";

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
