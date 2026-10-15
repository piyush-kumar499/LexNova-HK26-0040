import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLogRow } from "../models/audit.model.js";
import type { DeviceLocation, DeviceRow, TrustedContactRow } from "../models/device.model.js";
import type {
  DeliveryStatus,
  EvidenceKind,
  IncidentEvidenceRow,
  IncidentRecipientRow,
  IncidentResponderRow,
  RecipientType,
  SosIncidentRow,
  TriggerType,
} from "../models/sos.model.js";
import type { CallEventRow, CallProvider, CallStatus } from "../models/vapi.model.js";
import { isSupabaseConfigured, type AppConfig } from "../config/env.js";
import { DatabaseError } from "../utils/errors.js";
import { MemoryDatabase } from "./memory.service.js";

export interface NearbyDeviceResult {
  deviceId: string;
  distanceM: number;
}

export interface NearbyIncidentResult {
  incidentId: string;
  distanceM: number;
  triggerType: TriggerType;
  activatedAt: string;
}

export interface CreateSosIncidentInput {
  deviceId: string;
  triggerType: TriggerType;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: number | null;
  deviceTimestamp: string;
  activatedAt: string;
  clientRequestId: string;
}

export interface CreateCallEventInput {
  incidentId: string;
  provider: CallProvider;
  callReference: string | null;
  idempotencyKey: string | null;
  recipientReference: string | null;
  level: number | null;
  status: CallStatus;
}

/**
 * Persistence contract used by every service. Two implementations exist:
 *  - SupabaseDatabase: production path, SQL migrations in server/migrations.
 *  - MemoryDatabase: development fallback and the test double — never faked
 *    silently: the server logs loudly whenever it is in use, and production
 *    refuses to start without Supabase credentials.
 */
export interface Database {
  ping(): Promise<{ ok: boolean; error?: string }>;

  // devices
  getDeviceByDeviceId(deviceId: string): Promise<DeviceRow | null>;
  createDevice(deviceId: string): Promise<DeviceRow>;
  updateDevice(
    deviceId: string,
    patch: Partial<
      Pick<
        DeviceRow,
        "display_name" | "phone_number" | "can_respond" | "is_active" | "last_seen_at"
      >
    >,
  ): Promise<DeviceRow | null>;

  // locations (latest-only per device)
  upsertDeviceLocation(location: DeviceLocation): Promise<void>;
  getLatestDeviceLocation(deviceId: string): Promise<DeviceLocation | null>;
  findNearbyDevices(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
    maxAgeMinutes?: number;
  }): Promise<NearbyDeviceResult[]>;

  // trusted contacts
  listTrustedContacts(deviceId: string): Promise<TrustedContactRow[]>;
  createTrustedContact(input: {
    deviceId: string;
    contactName: string;
    phoneNumber: string;
    priority: number;
  }): Promise<TrustedContactRow>;
  deleteTrustedContact(deviceId: string, contactId: string): Promise<boolean>;

  // incidents
  insertSosIncident(input: CreateSosIncidentInput): Promise<SosIncidentRow>;
  getIncident(incidentId: string): Promise<SosIncidentRow | null>;
  findIncidentByClientRequestId(
    deviceId: string,
    clientRequestId: string,
  ): Promise<SosIncidentRow | null>;
  updateIncident(
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
  ): Promise<SosIncidentRow>;
  listOpenIncidents(): Promise<SosIncidentRow[]>;
  findNearbyActiveIncidents(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
  }): Promise<NearbyIncidentResult[]>;

  // incident recipients (call targets + delivery truth)
  getIncidentRecipient(params: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
  }): Promise<IncidentRecipientRow | null>;
  insertIncidentRecipient(input: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
    deliveryStatus: DeliveryStatus;
    providerReference?: string | null;
  }): Promise<IncidentRecipientRow>;
  updateIncidentRecipient(
    id: string,
    patch: Partial<
      Pick<IncidentRecipientRow, "delivery_status" | "acknowledged_at" | "provider_reference">
    >,
  ): Promise<IncidentRecipientRow>;
  listIncidentRecipients(incidentId: string): Promise<IncidentRecipientRow[]>;

  // incident responders (per-incident membership — the "roles")
  getIncidentResponder(incidentId: string, deviceId: string): Promise<IncidentResponderRow | null>;
  insertIncidentResponderIfAbsent(input: {
    incidentId: string;
    deviceId: string;
    distanceAtNotifyM: number | null;
    notifiedAt: string;
  }): Promise<{ row: IncidentResponderRow; created: boolean }>;
  updateIncidentResponder(
    incidentId: string,
    deviceId: string,
    patch: Partial<
      Pick<
        IncidentResponderRow,
        | "status"
        | "accepted_at"
        | "declined_at"
        | "en_route_at"
        | "arrived_at"
        | "withdrawn_at"
      >
    >,
  ): Promise<IncidentResponderRow>;
  listIncidentResponders(incidentId: string): Promise<IncidentResponderRow[]>;

  // responder events (append-only)
  appendResponderEvent(input: {
    incidentId: string;
    deviceId: string;
    eventType: string;
    metadata: Record<string, unknown> | null;
  }): Promise<void>;

  // call events
  insertCallEvent(input: CreateCallEventInput): Promise<CallEventRow>;
  findCallEventByReference(callReference: string): Promise<CallEventRow | null>;
  findCallEventByIdempotencyKey(idempotencyKey: string): Promise<CallEventRow | null>;
  updateCallEvent(
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
  ): Promise<CallEventRow>;
  listCallEvents(incidentId: string): Promise<CallEventRow[]>;

  // evidence
  insertIncidentEvidence(input: {
    incidentId: string;
    kind: EvidenceKind;
    storageRef: string;
    mediaType: string | null;
    capturedAt: string | null;
  }): Promise<IncidentEvidenceRow>;
  listIncidentEvidence(incidentId: string): Promise<IncidentEvidenceRow[]>;

  // audit
  appendAuditLog(input: {
    deviceId: string | null;
    incidentId: string | null;
    eventType: string;
    data: Record<string, unknown> | null;
  }): Promise<void>;
}

type Result<T> = { data: T; error: PostgrestError | null };

function unwrap<T>(result: Result<T>): T {
  if (result.error) {
    throw new DatabaseError(result.error.message, result.error.code);
  }
  return result.data;
}

export class SupabaseDatabase implements Database {
  constructor(private readonly client: SupabaseClient) {}

  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { error } = await this.client
        .from("devices")
        .select("id", { count: "exact", head: true })
        .limit(1);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getDeviceByDeviceId(deviceId: string): Promise<DeviceRow | null> {
    const { data, error } = await this.client
      .from("devices")
      .select("*")
      .eq("device_id", deviceId)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as DeviceRow | null) ?? null;
  }

  async createDevice(deviceId: string): Promise<DeviceRow> {
    const data = unwrap(
      (await this.client
        .from("devices")
        .insert({ device_id: deviceId, last_seen_at: new Date().toISOString() })
        .select("*")
        .single()) as Result<DeviceRow>,
    );
    return data;
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
    const { data, error } = await this.client
      .from("devices")
      .update(patch)
      .eq("device_id", deviceId)
      .select("*")
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as DeviceRow | null) ?? null;
  }

  async upsertDeviceLocation(location: DeviceLocation): Promise<void> {
    unwrap(
      await this.client.rpc("upsert_device_location", {
        p_device_id: location.device_id,
        p_latitude: location.latitude,
        p_longitude: location.longitude,
        p_accuracy: location.accuracy,
        p_captured_at: location.captured_at,
      }),
    );
  }

  async getLatestDeviceLocation(deviceId: string): Promise<DeviceLocation | null> {
    const rows = unwrap(
      (await this.client.rpc("latest_device_location", {
        p_device_id: deviceId,
      })) as Result<
        Array<{
          latitude: number;
          longitude: number;
          accuracy: number | null;
          captured_at: string;
        }>
      >,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      device_id: deviceId,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      captured_at: row.captured_at,
    };
  }

  async findNearbyDevices(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
    maxAgeMinutes?: number;
  }): Promise<NearbyDeviceResult[]> {
    const rows = unwrap(
      (await this.client.rpc("nearby_devices", {
        p_latitude: params.latitude,
        p_longitude: params.longitude,
        p_radius_meters: params.radiusMeters,
        p_max_results: params.maxResults,
        p_exclude_device_id: params.excludeDeviceId,
        p_max_age_minutes: params.maxAgeMinutes ?? 10,
      })) as Result<Array<{ device_id: string; distance_m: number }>>,
    );
    return rows.map((row) => ({ deviceId: row.device_id, distanceM: Number(row.distance_m) }));
  }

  async listTrustedContacts(deviceId: string): Promise<TrustedContactRow[]> {
    const data = unwrap(
      (await this.client
        .from("trusted_contacts")
        .select("*")
        .eq("device_id", deviceId)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true })) as Result<TrustedContactRow[]>,
    );
    return data;
  }

  async createTrustedContact(input: {
    deviceId: string;
    contactName: string;
    phoneNumber: string;
    priority: number;
  }): Promise<TrustedContactRow> {
    const data = unwrap(
      (await this.client
        .from("trusted_contacts")
        .insert({
          device_id: input.deviceId,
          contact_name: input.contactName,
          phone_number: input.phoneNumber,
          priority: input.priority,
        })
        .select("*")
        .single()) as Result<TrustedContactRow>,
    );
    return data;
  }

  async deleteTrustedContact(deviceId: string, contactId: string): Promise<boolean> {
    const data = unwrap(
      (await this.client
        .from("trusted_contacts")
        .delete()
        .eq("id", contactId)
        .eq("device_id", deviceId)
        .select("id")) as Result<Array<{ id: string }>>,
    );
    return data.length > 0;
  }

  async insertSosIncident(input: CreateSosIncidentInput): Promise<SosIncidentRow> {
    const data = unwrap(
      (await this.client
        .from("sos_incidents")
        .insert({
          device_id: input.deviceId,
          status: "ACTIVE",
          trigger_type: input.triggerType,
          latitude: input.latitude,
          longitude: input.longitude,
          location_accuracy: input.locationAccuracy,
          device_timestamp: input.deviceTimestamp,
          activated_at: input.activatedAt,
          client_request_id: input.clientRequestId,
        })
        .select("*")
        .single()) as Result<SosIncidentRow>,
    );
    return data;
  }

  async getIncident(incidentId: string): Promise<SosIncidentRow | null> {
    const { data, error } = await this.client
      .from("sos_incidents")
      .select("*")
      .eq("id", incidentId)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as SosIncidentRow | null) ?? null;
  }

  async findIncidentByClientRequestId(
    deviceId: string,
    clientRequestId: string,
  ): Promise<SosIncidentRow | null> {
    const { data, error } = await this.client
      .from("sos_incidents")
      .select("*")
      .eq("device_id", deviceId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as SosIncidentRow | null) ?? null;
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
    const data = unwrap(
      (await this.client
        .from("sos_incidents")
        .update(patch)
        .eq("id", incidentId)
        .select("*")
        .single()) as Result<SosIncidentRow>,
    );
    return data;
  }

  async listOpenIncidents(): Promise<SosIncidentRow[]> {
    const data = unwrap(
      (await this.client
        .from("sos_incidents")
        .select("*")
        .in("status", ["ACTIVE", "HELP_REQUESTED", "RESPONDER_ACKNOWLEDGED"])
        .order("created_at", { ascending: true })) as Result<SosIncidentRow[]>,
    );
    return data;
  }

  async findNearbyActiveIncidents(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    maxResults: number;
    excludeDeviceId: string;
  }): Promise<NearbyIncidentResult[]> {
    const rows = unwrap(
      (await this.client.rpc("nearby_active_incidents", {
        p_latitude: params.latitude,
        p_longitude: params.longitude,
        p_radius_meters: params.radiusMeters,
        p_max_results: params.maxResults,
        p_exclude_device_id: params.excludeDeviceId,
      })) as Result<
        Array<{
          incident_id: string;
          distance_m: number;
          trigger_type: TriggerType;
          activated_at: string;
        }>
      >,
    );
    return rows.map((row) => ({
      incidentId: row.incident_id,
      distanceM: Number(row.distance_m),
      triggerType: row.trigger_type,
      activatedAt: row.activated_at,
    }));
  }

  async getIncidentRecipient(params: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
  }): Promise<IncidentRecipientRow | null> {
    const { data, error } = await this.client
      .from("incident_recipients")
      .select("*")
      .eq("incident_id", params.incidentId)
      .eq("recipient_type", params.recipientType)
      .eq("recipient_reference", params.recipientReference)
      .eq("level", params.level)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as IncidentRecipientRow | null) ?? null;
  }

  async insertIncidentRecipient(input: {
    incidentId: string;
    recipientType: RecipientType;
    recipientReference: string;
    level: number;
    deliveryStatus: DeliveryStatus;
    providerReference?: string | null;
  }): Promise<IncidentRecipientRow> {
    const data = unwrap(
      (await this.client
        .from("incident_recipients")
        .insert({
          incident_id: input.incidentId,
          recipient_type: input.recipientType,
          recipient_reference: input.recipientReference,
          level: input.level,
          delivery_status: input.deliveryStatus,
          provider_reference: input.providerReference ?? null,
        })
        .select("*")
        .single()) as Result<IncidentRecipientRow>,
    );
    return data;
  }

  async updateIncidentRecipient(
    id: string,
    patch: Partial<
      Pick<IncidentRecipientRow, "delivery_status" | "acknowledged_at" | "provider_reference">
    >,
  ): Promise<IncidentRecipientRow> {
    const data = unwrap(
      (await this.client
        .from("incident_recipients")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single()) as Result<IncidentRecipientRow>,
    );
    return data;
  }

  async listIncidentRecipients(incidentId: string): Promise<IncidentRecipientRow[]> {
    const data = unwrap(
      (await this.client
        .from("incident_recipients")
        .select("*")
        .eq("incident_id", incidentId)
        .order("created_at", { ascending: true })) as Result<IncidentRecipientRow[]>,
    );
    return data;
  }

  async getIncidentResponder(
    incidentId: string,
    deviceId: string,
  ): Promise<IncidentResponderRow | null> {
    const { data, error } = await this.client
      .from("incident_responders")
      .select("*")
      .eq("incident_id", incidentId)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as IncidentResponderRow | null) ?? null;
  }

  async insertIncidentResponderIfAbsent(input: {
    incidentId: string;
    deviceId: string;
    distanceAtNotifyM: number | null;
    notifiedAt: string;
  }): Promise<{ row: IncidentResponderRow; created: boolean }> {
    const existing = await this.getIncidentResponder(input.incidentId, input.deviceId);
    if (existing) return { row: existing, created: false };
    try {
      const row = unwrap(
        (await this.client
          .from("incident_responders")
          .insert({
            incident_id: input.incidentId,
            device_id: input.deviceId,
            status: "NOTIFIED",
            distance_at_notify_m: input.distanceAtNotifyM,
            notified_at: input.notifiedAt,
          })
          .select("*")
          .single()) as Result<IncidentResponderRow>,
      );
      return { row, created: true };
    } catch (error) {
      if (error instanceof DatabaseError && error.code === "23505") {
        const row = await this.getIncidentResponder(input.incidentId, input.deviceId);
        if (row) return { row, created: false };
      }
      throw error;
    }
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
    const data = unwrap(
      (await this.client
        .from("incident_responders")
        .update(patch)
        .eq("incident_id", incidentId)
        .eq("device_id", deviceId)
        .select("*")
        .single()) as Result<IncidentResponderRow>,
    );
    return data;
  }

  async listIncidentResponders(incidentId: string): Promise<IncidentResponderRow[]> {
    const data = unwrap(
      (await this.client
        .from("incident_responders")
        .select("*")
        .eq("incident_id", incidentId)
        .order("notified_at", { ascending: true })) as Result<IncidentResponderRow[]>,
    );
    return data;
  }

  async appendResponderEvent(input: {
    incidentId: string;
    deviceId: string;
    eventType: string;
    metadata: Record<string, unknown> | null;
  }): Promise<void> {
    unwrap(
      await this.client.from("responder_events").insert({
        incident_id: input.incidentId,
        device_id: input.deviceId,
        event_type: input.eventType,
        event_metadata: input.metadata,
      }),
    );
  }

  async insertCallEvent(input: CreateCallEventInput): Promise<CallEventRow> {
    const data = unwrap(
      (await this.client
        .from("call_events")
        .insert({
          incident_id: input.incidentId,
          provider: input.provider,
          call_reference: input.callReference,
          idempotency_key: input.idempotencyKey,
          recipient_reference: input.recipientReference,
          level: input.level,
          status: input.status,
        })
        .select("*")
        .single()) as Result<CallEventRow>,
    );
    return data;
  }

  async findCallEventByReference(callReference: string): Promise<CallEventRow | null> {
    const { data, error } = await this.client
      .from("call_events")
      .select("*")
      .eq("call_reference", callReference)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as CallEventRow | null) ?? null;
  }

  async findCallEventByIdempotencyKey(idempotencyKey: string): Promise<CallEventRow | null> {
    const { data, error } = await this.client
      .from("call_events")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new DatabaseError(error.message, error.code);
    return (data as CallEventRow | null) ?? null;
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
    const data = unwrap(
      (await this.client
        .from("call_events")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single()) as Result<CallEventRow>,
    );
    return data;
  }

  async listCallEvents(incidentId: string): Promise<CallEventRow[]> {
    const data = unwrap(
      (await this.client
        .from("call_events")
        .select("*")
        .eq("incident_id", incidentId)
        .order("created_at", { ascending: true })) as Result<CallEventRow[]>,
    );
    return data;
  }

  async insertIncidentEvidence(input: {
    incidentId: string;
    kind: EvidenceKind;
    storageRef: string;
    mediaType: string | null;
    capturedAt: string | null;
  }): Promise<IncidentEvidenceRow> {
    const data = unwrap(
      (await this.client
        .from("incident_evidence")
        .insert({
          incident_id: input.incidentId,
          kind: input.kind,
          storage_ref: input.storageRef,
          media_type: input.mediaType,
          captured_at: input.capturedAt,
        })
        .select("*")
        .single()) as Result<IncidentEvidenceRow>,
    );
    return data;
  }

  async listIncidentEvidence(incidentId: string): Promise<IncidentEvidenceRow[]> {
    const data = unwrap(
      (await this.client
        .from("incident_evidence")
        .select("*")
        .eq("incident_id", incidentId)
        .order("created_at", { ascending: true })) as Result<IncidentEvidenceRow[]>,
    );
    return data;
  }

  async appendAuditLog(input: {
    deviceId: string | null;
    incidentId: string | null;
    eventType: string;
    data: Record<string, unknown> | null;
  }): Promise<void> {
    unwrap(
      await this.client.from("audit_logs").insert({
        device_id: input.deviceId,
        incident_id: input.incidentId,
        event_type: input.eventType,
        event_data: input.data,
      }),
    );
  }
}

export interface DatabaseBundle {
  db: Database;
  mode: "supabase" | "memory";
}

/**
 * Chooses the persistence backend. Supabase when configured; otherwise the
 * in-memory database with a loud warning (development only — production is
 * already rejected by loadConfig without Supabase credentials).
 */
export function createDatabase(config: AppConfig, logger: FastifyBaseLogger): DatabaseBundle {
  if (isSupabaseConfigured(config)) {
    const client = createClient(config.supabase.url as string, config.supabase.serviceRoleKey as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return { db: new SupabaseDatabase(client), mode: "supabase" };
  }
  logger.warn(
    "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — using the IN-MEMORY database. " +
      "All data (devices, incidents, calls) will be lost on restart. Development only.",
  );
  return { db: new MemoryDatabase(), mode: "memory" };
}

export { MemoryDatabase };
