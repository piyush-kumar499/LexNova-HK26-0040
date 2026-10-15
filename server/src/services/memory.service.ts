import { randomUUID } from "node:crypto";
import type { AuditLogRow } from "../models/audit.model.js";
import type { DeviceLocation, DeviceRow, TrustedContactRow } from "../models/device.model.js";
import type {
  EvidenceKind,
  IncidentEvidenceRow,
  IncidentRecipientRow,
  IncidentResponderRow,
  RecipientType,
  SosIncidentRow,
  TriggerType,
} from "../models/sos.model.js";
import type { CallEventRow } from "../models/vapi.model.js";
import { DatabaseError, PG_UNIQUE_VIOLATION } from "../utils/errors.js";
import type {
  CreateCallEventInput,
  CreateSosIncidentInput,
  Database,
  NearbyDeviceResult,
  NearbyIncidentResult,
} from "./supabase.service.js";

const NO_ROWS_FOUND = "PGRST116";

const nowIso = (): string => new Date().toISOString();

function uniqueViolation(detail: string): DatabaseError {
  return new DatabaseError(`duplicate key value violates unique constraint: ${detail}`, PG_UNIQUE_VIOLATION);
}

/** Mean-radius great-circle distance — close to PostGIS geography st_distance (spheroid). */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadiusM = 6_371_008.8;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-memory implementation of the Database contract. Used for development when
 * Supabase is unconfigured and as the deterministic double in tests. It mimics
 * the constraints that matter (unique client_request_id per device, unique
 * contact phone per device, unique call idempotency key) so services behave
 * identically against both backends.
 */
export class MemoryDatabase implements Database {
  private readonly devices = new Map<string, DeviceRow>();
  private readonly locations = new Map<string, DeviceLocation>();
  private readonly contacts = new Map<string, TrustedContactRow>();
  private readonly incidents = new Map<string, SosIncidentRow>();
  private readonly recipients = new Map<string, IncidentRecipientRow>();
  private readonly responders = new Map<string, IncidentResponderRow>();
  private readonly responderEvents: Array<Record<string, unknown>> = [];
  private readonly callEvents = new Map<string, CallEventRow>();
  private readonly evidence: IncidentEvidenceRow[] = [];
  private readonly auditLogs: AuditLogRow[] = [];

  async ping(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async getDeviceByDeviceId(deviceId: string): Promise<DeviceRow | null> {
    const row = this.devices.get(deviceId);
    return row ? clone(row) : null;
  }

  async createDevice(deviceId: string): Promise<DeviceRow> {
    if (this.devices.has(deviceId)) throw uniqueViolation("devices.device_id");
    const t = nowIso();
    const row: DeviceRow = {
      id: randomUUID(),
      device_id: deviceId,
      display_name: null,
      phone_number: null,
      is_active: true,
      can_respond: true,
      created_at: t,
      updated_at: t,
      last_seen_at: t,
    };
    this.devices.set(deviceId, row);
    return clone(row);
  }

  async updateDevice(
    deviceId: string,
    patch: Partial<
      Pick<
        DeviceRow,
        "display_name" | "phone_number" | "can_respond" | "is_active" | "last_seen_at"
      >
    >,
  ): Promise<DeviceRow | null> {
    const row = this.devices.get(deviceId);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async upsertDeviceLocation(location: DeviceLocation): Promise<void> {
    if (!this.devices.has(location.device_id)) {
      throw new DatabaseError("device_locations.device_id foreign key violation", "23503");
    }
    this.locations.set(location.device_id, clone(location));
  }

  async getLatestDeviceLocation(deviceId: string): Promise<DeviceLocation | null> {
    const row = this.locations.get(deviceId);
    return row ? clone(row) : null;
  }

  async findNearbyDevices(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
    maxAgeMinutes?: number;
  }): Promise<NearbyDeviceResult[]> {
    const maxAgeMs = (params.maxAgeMinutes ?? 10) * 60_000;
    const cutoff = Date.now() - maxAgeMs;
    const results: NearbyDeviceResult[] = [];
    for (const [deviceId, location] of this.locations) {
      if (deviceId === params.excludeDeviceId) continue;
      const device = this.devices.get(deviceId);
      if (!device || !device.is_active || !device.can_respond) continue;
      if (Date.parse(location.captured_at) <= cutoff) continue;
      const distanceM = haversineMeters(
        params.latitude,
        params.longitude,
        location.latitude,
        location.longitude,
      );
      if (distanceM <= params.radiusMeters) {
        results.push({ deviceId, distanceM });
      }
    }
    results.sort((a, b) => a.distanceM - b.distanceM);
    return results.slice(0, params.maxResults);
  }

  async listTrustedContacts(deviceId: string): Promise<TrustedContactRow[]> {
    return [...this.contacts.values()]
      .filter((row) => row.device_id === deviceId)
      .sort((a, b) =>
        a.priority === b.priority
          ? a.created_at.localeCompare(b.created_at)
          : a.priority - b.priority,
      )
      .map(clone);
  }

  async createTrustedContact(input: {
    deviceId: string;
    contactName: string;
    phoneNumber: string;
    priority: number;
  }): Promise<TrustedContactRow> {
    for (const row of this.contacts.values()) {
      if (row.device_id === input.deviceId && row.phone_number === input.phoneNumber) {
        throw uniqueViolation("trusted_contacts.device_id+phone_number");
      }
    }
    const t = nowIso();
    const row: TrustedContactRow = {
      id: randomUUID(),
      device_id: input.deviceId,
      contact_name: input.contactName,
      phone_number: input.phoneNumber,
      priority: input.priority,
      created_at: t,
      updated_at: t,
    };
    this.contacts.set(row.id, row);
    return clone(row);
  }

  async deleteTrustedContact(deviceId: string, contactId: string): Promise<boolean> {
    const row = this.contacts.get(contactId);
    if (!row || row.device_id !== deviceId) return false;
    this.contacts.delete(contactId);
    return true;
  }

  async insertSosIncident(input: CreateSosIncidentInput): Promise<SosIncidentRow> {
    for (const row of this.incidents.values()) {
      if (row.device_id === input.deviceId && row.client_request_id === input.clientRequestId) {
        throw uniqueViolation("sos_incidents.device_id+client_request_id");
      }
    }
    const t = nowIso();
    const row: SosIncidentRow = {
      id: randomUUID(),
      device_id: input.deviceId,
      status: "ACTIVE",
      trigger_type: input.triggerType,
      latitude: input.latitude,
      longitude: input.longitude,
      location_accuracy: input.locationAccuracy,
      device_timestamp: input.deviceTimestamp,
      activated_at: input.activatedAt,
      escalation_level: 0,
      client_request_id: input.clientRequestId,
      cancel_reason: null,
      resolution_reason: null,
      cancelled_at: null,
      resolved_at: null,
      created_at: t,
      updated_at: t,
    };
    this.incidents.set(row.id, row);
    return clone(row);
  }

  async getIncident(incidentId: string): Promise<SosIncidentRow | null> {
    const row = this.incidents.get(incidentId);
    return row ? clone(row) : null;
  }

  async findIncidentByClientRequestId(
    deviceId: string,
    clientRequestId: string,
  ): Promise<SosIncidentRow | null> {
    for (const row of this.incidents.values()) {
      if (row.device_id === deviceId && row.client_request_id === clientRequestId) {
        return clone(row);
      }
    }
    return null;
  }

  async updateIncident(
    incidentId: string,
    patch: Partial<
      Pick<
        SosIncidentRow,
        | "status"
        | "cancel_reason"
        | "resolution_reason"
        | "cancelled_at"
        | "resolved_at"
        | "escalation_level"
      >
    >,
  ): Promise<SosIncidentRow> {
    const row = this.incidents.get(incidentId);
    if (!row) throw new DatabaseError("No rows found", NO_ROWS_FOUND);
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async listOpenIncidents(): Promise<SosIncidentRow[]> {
    return [...this.incidents.values()]
      .filter((row) =>
        ["ACTIVE", "HELP_REQUESTED", "RESPONDER_ACKNOWLEDGED"].includes(row.status),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(clone);
  }

  async findNearbyActiveIncidents(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
  }): Promise<NearbyIncidentResult[]> {
    const results: NearbyIncidentResult[] = [];
    for (const row of this.incidents.values()) {
      if (row.status === "RESOLVED" || row.status === "CANCELLED") continue;
      if (row.device_id === params.excludeDeviceId) continue;
      if (row.latitude === null || row.longitude === null) continue;
      const distanceM = haversineMeters(
        params.latitude,
        params.longitude,
        row.latitude,
        row.longitude,
      );
      if (distanceM <= params.radiusMeters) {
        results.push({
          incidentId: row.id,
          distanceM,
          triggerType: row.trigger_type,
          activatedAt: row.activated_at,
        });
      }
    }
    results.sort((a, b) => a.distanceM - b.distanceM);
    return results.slice(0, params.maxResults);
  }

  async getIncidentRecipient(params: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
  }): Promise<IncidentRecipientRow | null> {
    for (const row of this.recipients.values()) {
      if (
        row.incident_id === params.incidentId &&
        row.recipient_type === params.recipientType &&
        row.recipient_reference === params.recipientReference &&
        row.level === params.level
      ) {
        return clone(row);
      }
    }
    return null;
  }

  async insertIncidentRecipient(input: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
    deliveryStatus: IncidentRecipientRow["delivery_status"];
    providerReference?: string | null;
  }): Promise<IncidentRecipientRow> {
    const existing = await this.getIncidentRecipient({
      incidentId: input.incidentId,
      recipientType: input.recipientType,
      recipientReference: input.recipientReference,
      level: input.level,
    });
    if (existing) throw uniqueViolation("incident_recipients.incident+type+ref+level");
    const t = nowIso();
    const row: IncidentRecipientRow = {
      id: randomUUID(),
      incident_id: input.incidentId,
      recipient_type: input.recipientType,
      recipient_reference: input.recipientReference,
      level: input.level,
      delivery_status: input.deliveryStatus,
      provider_reference: input.providerReference ?? null,
      acknowledged_at: null,
      created_at: t,
      updated_at: t,
    };
    this.recipients.set(row.id, row);
    return clone(row);
  }

  async updateIncidentRecipient(
    id: string,
    patch: Partial<
      Pick<IncidentRecipientRow, "delivery_status" | "acknowledged_at" | "provider_reference">
    >,
  ): Promise<IncidentRecipientRow> {
    const row = this.recipients.get(id);
    if (!row) throw new DatabaseError("No rows found", NO_ROWS_FOUND);
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async listIncidentRecipients(incidentId: string): Promise<IncidentRecipientRow[]> {
    return [...this.recipients.values()]
      .filter((row) => row.incident_id === incidentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(clone);
  }

  async getIncidentResponder(
    incidentId: string,
    deviceId: string,
  ): Promise<IncidentResponderRow | null> {
    const row = this.responders.get(`${incidentId}|${deviceId}`);
    return row ? clone(row) : null;
  }

  async insertIncidentResponderIfAbsent(input: {
    incidentId: string;
    deviceId: string;
    distanceAtNotifyM: number | null;
    notifiedAt: string;
  }): Promise<{ row: IncidentResponderRow; created: boolean }> {
    const key = `${input.incidentId}|${input.deviceId}`;
    const existing = this.responders.get(key);
    if (existing) return { row: clone(existing), created: false };
    const t = nowIso();
    const row: IncidentResponderRow = {
      incident_id: input.incidentId,
      device_id: input.deviceId,
      status: "NOTIFIED",
      distance_at_notify_m: input.distanceAtNotifyM,
      notified_at: input.notifiedAt,
      accepted_at: null,
      declined_at: null,
      en_route_at: null,
      arrived_at: null,
      withdrawn_at: null,
      created_at: t,
      updated_at: t,
    };
    this.responders.set(key, row);
    return { row: clone(row), created: true };
  }

  async updateIncidentResponder(
    incidentId: string,
    deviceId: string,
    patch: Partial<
      Pick<
        IncidentResponderRow,
        "status" | "accepted_at" | "declined_at" | "en_route_at" | "arrived_at" | "withdrawn_at"
      >
    >,
  ): Promise<IncidentResponderRow> {
    const key = `${incidentId}|${deviceId}`;
    const row = this.responders.get(key);
    if (!row) throw new DatabaseError("No rows found", NO_ROWS_FOUND);
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async listIncidentResponders(incidentId: string): Promise<IncidentResponderRow[]> {
    return [...this.responders.values()]
      .filter((row) => row.incident_id === incidentId)
      .sort((a, b) => a.notified_at.localeCompare(b.notified_at))
      .map(clone);
  }

  async appendResponderEvent(input: {
    incidentId: string;
    deviceId: string;
    eventType: string;
    metadata: Record<string, unknown> | null;
  }): Promise<void> {
    this.responderEvents.push({
      id: randomUUID(),
      incident_id: input.incidentId,
      device_id: input.deviceId,
      event_type: input.eventType,
      event_metadata: input.metadata,
      created_at: nowIso(),
    });
  }

  async insertCallEvent(input: CreateCallEventInput): Promise<CallEventRow> {
    for (const row of this.callEvents.values()) {
      if (input.callReference !== null && row.call_reference === input.callReference) {
        throw uniqueViolation("call_events.call_reference");
      }
      if (input.idempotencyKey !== null && row.idempotency_key === input.idempotencyKey) {
        throw uniqueViolation("call_events.idempotency_key");
      }
    }
    const t = nowIso();
    const row: CallEventRow = {
      id: randomUUID(),
      incident_id: input.incidentId,
      provider: input.provider,
      call_reference: input.callReference,
      idempotency_key: input.idempotencyKey,
      recipient_reference: input.recipientReference,
      level: input.level,
      attempt: 1,
      status: input.status,
      ended_reason: null,
      started_at: null,
      answered_at: null,
      ended_at: null,
      recording_ref: null,
      transcript: null,
      raw_event: null,
      created_at: t,
      updated_at: t,
    };
    this.callEvents.set(row.id, row);
    return clone(row);
  }

  async findCallEventByReference(callReference: string): Promise<CallEventRow | null> {
    for (const row of this.callEvents.values()) {
      if (row.call_reference === callReference) return clone(row);
    }
    return null;
  }

  async findCallEventByIdempotencyKey(idempotencyKey: string): Promise<CallEventRow | null> {
    for (const row of this.callEvents.values()) {
      if (row.idempotency_key === idempotencyKey) return clone(row);
    }
    return null;
  }

  async updateCallEvent(
    id: string,
    patch: Partial<
      Pick<
        CallEventRow,
        | "status"
        | "ended_reason"
        | "started_at"
        | "answered_at"
        | "ended_at"
        | "recording_ref"
        | "transcript"
        | "raw_event"
      >
    >,
  ): Promise<CallEventRow> {
    const row = this.callEvents.get(id);
    if (!row) throw new DatabaseError("No rows found", NO_ROWS_FOUND);
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async listCallEvents(incidentId: string): Promise<CallEventRow[]> {
    return [...this.callEvents.values()]
      .filter((row) => row.incident_id === incidentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(clone);
  }

  async insertIncidentEvidence(input: {
    incidentId: string;
    kind: EvidenceKind;
    storageRef: string;
    mediaType: string | null;
    capturedAt: string | null;
  }): Promise<IncidentEvidenceRow> {
    const row: IncidentEvidenceRow = {
      id: randomUUID(),
      incident_id: input.incidentId,
      kind: input.kind,
      storage_ref: input.storageRef,
      media_type: input.mediaType,
      captured_at: input.capturedAt,
      created_at: nowIso(),
    };
    this.evidence.push(row);
    return clone(row);
  }

  async listIncidentEvidence(incidentId: string): Promise<IncidentEvidenceRow[]> {
    return this.evidence
      .filter((row) => row.incident_id === incidentId)
      .map(clone);
  }

  async appendAuditLog(input: {
    deviceId: string | null;
    incidentId: string | null;
    eventType: string;
    data: Record<string, unknown> | null;
  }): Promise<void> {
    this.auditLogs.push({
      id: randomUUID(),
      device_id: input.deviceId,
      incident_id: input.incidentId,
      event_type: input.eventType,
      event_data: input.data,
      created_at: nowIso(),
    });
  }

  // ---- test-only inspection helpers (not part of the Database contract) ----

  getAuditLogs(): AuditLogRow[] {
    return clone(this.auditLogs);
  }

  getResponderEvents(): Array<Record<string, unknown>> {
    return clone(this.responderEvents);
  }

  /** Test helper: set a location as if captured `ageMs` ago. */
  seedDeviceLocation(
    deviceId: string,
    latitude: number,
    longitude: number,
    ageMs = 0,
    accuracy: number | null = 10,
  ): void {
    this.locations.set(deviceId, {
      device_id: deviceId,
      latitude,
      longitude,
      accuracy,
      captured_at: new Date(Date.now() - ageMs).toISOString(),
    });
  }

  /** Test helper: mark a device as created earlier (keeps auth flow quiet). */
  seedDevice(deviceId: string, patch: Partial<DeviceRow> = {}): DeviceRow {
    const t = nowIso();
    const row: DeviceRow = {
      id: randomUUID(),
      device_id: deviceId,
      display_name: null,
      phone_number: null,
      is_active: true,
      can_respond: true,
      created_at: t,
      updated_at: t,
      last_seen_at: t,
      ...patch,
    };
    this.devices.set(deviceId, row);
    return clone(row);
  }
}
