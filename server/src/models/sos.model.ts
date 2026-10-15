import { z } from "zod";
import { AppError } from "../utils/errors.js";

export const INCIDENT_STATUSES = [
  "CREATED",
  "ACTIVE",
  "HELP_REQUESTED",
  "RESPONDER_ACKNOWLEDGED",
  "RESOLVED",
  "CANCELLED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/**
 * Allowed incident transitions (spec §9). Anything else is rejected with 409.
 * CREATED -> ACTIVE happens at incident creation.
 */
const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  CREATED: ["ACTIVE"],
  ACTIVE: ["HELP_REQUESTED", "CANCELLED"],
  HELP_REQUESTED: ["RESPONDER_ACKNOWLEDGED", "CANCELLED"],
  RESPONDER_ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
  CANCELLED: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export function assertIncidentTransition(
  from: IncidentStatus,
  to: IncidentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      409,
      `Illegal incident transition: ${from} -> ${to}`,
      { from, to },
    );
  }
}

export const RESPONDER_STATUSES = [
  "NOTIFIED",
  "ACCEPTED",
  "DECLINED",
  "EN_ROUTE",
  "ARRIVED",
  "WITHDRAWN",
] as const;
export type ResponderStatus = (typeof RESPONDER_STATUSES)[number];

/**
 * Per-responder transitions (spec §9). Accepting does NOT mean help arrived —
 * each step is tracked separately.
 */
const RESPONDER_TRANSITIONS: Record<ResponderStatus, readonly ResponderStatus[]> = {
  NOTIFIED: ["ACCEPTED", "DECLINED"],
  ACCEPTED: ["EN_ROUTE", "WITHDRAWN"],
  EN_ROUTE: ["ARRIVED", "WITHDRAWN"],
  ARRIVED: [],
  DECLINED: [],
  WITHDRAWN: [],
};

export function canResponderTransition(
  from: ResponderStatus,
  to: ResponderStatus,
): boolean {
  return RESPONDER_TRANSITIONS[from].includes(to);
}

export function assertResponderTransition(
  from: ResponderStatus,
  to: ResponderStatus,
): void {
  if (!canResponderTransition(from, to)) {
    throw new AppError(
      "INVALID_RESPONDER_TRANSITION",
      409,
      `Illegal responder transition: ${from} -> ${to}`,
      { from, to },
    );
  }
}

export const RESPONDER_ACTIONS = [
  "ACCEPT",
  "DECLINE",
  "EN_ROUTE",
  "ARRIVED",
  "WITHDRAW",
] as const;
export type ResponderAction = (typeof RESPONDER_ACTIONS)[number];

export const ACTION_TO_STATUS: Record<ResponderAction, ResponderStatus> = {
  ACCEPT: "ACCEPTED",
  DECLINE: "DECLINED",
  EN_ROUTE: "EN_ROUTE",
  ARRIVED: "ARRIVED",
  WITHDRAW: "WITHDRAWN",
};

export type TriggerType = "shake" | "button" | "voice";
export const TRIGGER_TYPES = ["shake", "button", "voice"] as const;

export interface SosIncidentRow {
  id: string;
  device_id: string;
  status: IncidentStatus;
  trigger_type: TriggerType;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  device_timestamp: string;
  activated_at: string;
  escalation_level: number;
  client_request_id: string;
  cancel_reason: string | null;
  resolution_reason: string | null;
  cancelled_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentResponderRow {
  incident_id: string;
  device_id: string;
  status: ResponderStatus;
  distance_at_notify_m: number | null;
  notified_at: string;
  accepted_at: string | null;
  declined_at: string | null;
  en_route_at: string | null;
  arrived_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

export const RECIPIENT_TYPES = [
  "trusted_contact",
  "nearby_device",
  "response_team",
] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const DELIVERY_STATUSES = [
  "PENDING",
  "ATTEMPTED",
  "DELIVERED",
  "ACKNOWLEDGED",
  "FAILED",
  "DECLINED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Notification target + delivery truth. Delivery/ack/failure are separate facts. */
export interface IncidentRecipientRow {
  id: string;
  incident_id: string;
  recipient_type: RecipientType;
  recipient_reference: string;
  level: number;
  delivery_status: DeliveryStatus;
  provider_reference: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Append-only responder audit trail. */
export interface ResponderEventRow {
  id: string;
  incident_id: string;
  device_id: string;
  event_type: string;
  event_metadata: Record<string, unknown> | null;
  created_at: string;
}

export const EVIDENCE_KINDS = ["call_recording", "call_transcript"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface IncidentEvidenceRow {
  id: string;
  incident_id: string;
  kind: EvidenceKind;
  storage_ref: string;
  media_type: string | null;
  captured_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * POST /sos. Coordinates are optional: the app may lack location permission,
 * in which case the server falls back to the device's latest stored fix.
 * deviceTimestamp is the on-device activation time — for offline-queued
 * events (spec §14) it may be in the past and becomes activated_at.
 */
export const createSosSchema = z
  .object({
    triggerType: z.enum(TRIGGER_TYPES),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    locationAccuracy: z.number().min(0).max(100_000).optional(),
    deviceTimestamp: z.iso.datetime({ offset: true }),
    clientRequestId: z.string().trim().min(1).max(128),
  })
  .strict()
  .refine((data) => (data.latitude === undefined) === (data.longitude === undefined), {
    error: "latitude and longitude must be provided together",
    path: ["longitude"],
  });

export type CreateSosInput = z.infer<typeof createSosSchema>;

/** POST /sos/:incidentId/cancel — the explicit false-alarm flow. */
export const cancelSosSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export type CancelSosInput = z.infer<typeof cancelSosSchema>;

/** POST /sos/:incidentId/resolve */
export const resolveSosSchema = z
  .object({ resolutionReason: z.string().trim().min(1).max(1000) })
  .strict();

export type ResolveSosInput = z.infer<typeof resolveSosSchema>;

/** POST /sos/:incidentId/respond — one deliberate step per action. */
export const respondSosSchema = z
  .object({ action: z.enum(RESPONDER_ACTIONS) })
  .strict();

export type RespondSosInput = z.infer<typeof respondSosSchema>;
