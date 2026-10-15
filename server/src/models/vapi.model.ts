export const CALL_PROVIDERS = ["vapi", "mock"] as const;
export type CallProvider = (typeof CALL_PROVIDERS)[number];

export const CALL_STATUSES = [
  "QUEUED",
  "RINGING",
  "IN_PROGRESS",
  "ANSWERED",
  "ENDED",
  "NO_ANSWER",
  "FAILED",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * Normalized webhook events our server handles (spec §5.10). Raw provider
 * payloads are mapped defensively into these by the Vapi webhook service and
 * the untouched payload is stored in call_events.raw_event for audit.
 */
export const VAPI_WEBHOOK_EVENT_TYPES = [
  "call.started",
  "call.answered",
  "call.ended",
  "call.no-answer",
  "call.failed",
  "recording.ready",
  "transcript.ready",
] as const;
export type VapiWebhookEventType = (typeof VAPI_WEBHOOK_EVENT_TYPES)[number];

export interface CallEventRow {
  id: string;
  incident_id: string;
  provider: CallProvider;
  call_reference: string | null;
  idempotency_key: string | null;
  recipient_reference: string | null;
  level: number | null;
  attempt: number;
  status: CallStatus;
  ended_reason: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  recording_ref: string | null;
  transcript: string | null;
  raw_event: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
