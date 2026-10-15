import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDatabase, haversineMeters } from "../src/services/memory.service.js";
import { isUniqueViolation } from "../src/utils/errors.js";
import { VALID_DEVICE_ID, VALID_DEVICE_ID_2, VALID_DEVICE_ID_3 } from "./helpers/setup.js";

// Bengaluru reference points for distance math (same city, few km apart)
const POINT_A = { lat: 12.9716, lon: 77.5946 }; // MG Road
const POINT_B = { lat: 12.9582, lon: 77.6018 }; // ~1.6 km away
const POINT_C = { lat: 12.8452, lon: 77.6602 }; // ~17 km away

describe("MemoryDatabase", () => {
  let db: MemoryDatabase;

  beforeEach(() => {
    db = new MemoryDatabase();
  });

  it("creates devices once and rejects duplicates with a unique violation", async () => {
    const device = await db.createDevice(VALID_DEVICE_ID);
    expect(device.device_id).toBe(VALID_DEVICE_ID);
    expect(device.can_respond).toBe(true);
    expect(device.is_active).toBe(true);

    const fetched = await db.getDeviceByDeviceId(VALID_DEVICE_ID);
    expect(fetched?.id).toBe(device.id);

    await expect(db.createDevice(VALID_DEVICE_ID)).rejects.toSatisfy(isUniqueViolation);
  });

  it("updates device fields without touching device_id", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    const updated = await db.updateDevice(VALID_DEVICE_ID, {
      display_name: "Asha",
      can_respond: false,
    });
    expect(updated?.display_name).toBe("Asha");
    expect(updated?.can_respond).toBe(false);
    expect(updated?.device_id).toBe(VALID_DEVICE_ID);
    expect(await db.updateDevice(VALID_DEVICE_ID_2, { display_name: "x" })).toBeNull();
  });

  it("keeps only the latest location per device", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    await db.upsertDeviceLocation({
      device_id: VALID_DEVICE_ID,
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      accuracy: 5,
      captured_at: new Date().toISOString(),
    });
    await db.upsertDeviceLocation({
      device_id: VALID_DEVICE_ID,
      latitude: POINT_B.lat,
      longitude: POINT_B.lon,
      accuracy: 8,
      captured_at: new Date().toISOString(),
    });
    const latest = await db.getLatestDeviceLocation(VALID_DEVICE_ID);
    expect(latest?.latitude).toBeCloseTo(POINT_B.lat, 6);
    expect(latest?.longitude).toBeCloseTo(POINT_B.lon, 6);
  });

  it("rejects locations for unknown devices (foreign key)", async () => {
    await expect(
      db.upsertDeviceLocation({
        device_id: VALID_DEVICE_ID,
        latitude: 0,
        longitude: 0,
        accuracy: null,
        captured_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it("finds nearby devices sorted by distance with all privacy/eligibility filters", async () => {
    await db.createDevice(VALID_DEVICE_ID); // seeker
    await db.createDevice(VALID_DEVICE_ID_2); // helper ~1.6 km
    await db.createDevice(VALID_DEVICE_ID_3); // ~17 km, outside 5 km radius

    db.seedDeviceLocation(VALID_DEVICE_ID, POINT_A.lat, POINT_A.lon);
    db.seedDeviceLocation(VALID_DEVICE_ID_2, POINT_B.lat, POINT_B.lon);
    db.seedDeviceLocation(VALID_DEVICE_ID_3, POINT_C.lat, POINT_C.lon);

    const found = await db.findNearbyDevices({
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      radiusMeters: 5000,
      maxResults: 50,
      excludeDeviceId: VALID_DEVICE_ID,
    });

    expect(found.map((r) => r.deviceId)).toEqual([VALID_DEVICE_ID_2]);
    expect(found[0]!.distanceM).toBeGreaterThan(1000);
    expect(found[0]!.distanceM).toBeLessThan(2500);
  });

  it("excludes stale locations, non-responding and inactive devices", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    await db.createDevice(VALID_DEVICE_ID_2);
    await db.createDevice(VALID_DEVICE_ID_3);

    db.seedDeviceLocation(VALID_DEVICE_ID, POINT_A.lat, POINT_A.lon);
    db.seedDeviceLocation(VALID_DEVICE_ID_2, POINT_B.lat, POINT_B.lon, 11 * 60_000); // stale
    db.seedDeviceLocation(VALID_DEVICE_ID_3, POINT_B.lat, POINT_B.lon);
    await db.updateDevice(VALID_DEVICE_ID_3, { can_respond: false });

    const found = await db.findNearbyDevices({
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      radiusMeters: 5000,
      maxResults: 50,
      excludeDeviceId: VALID_DEVICE_ID,
    });
    expect(found).toEqual([]);

    await db.updateDevice(VALID_DEVICE_ID_3, { can_respond: true, is_active: false });
    const found2 = await db.findNearbyDevices({
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      radiusMeters: 5000,
      maxResults: 50,
      excludeDeviceId: VALID_DEVICE_ID,
    });
    expect(found2).toEqual([]);
  });

  it("enforces SOS idempotency on device_id + client_request_id", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    const input = {
      deviceId: VALID_DEVICE_ID,
      triggerType: "button" as const,
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      clientRequestId: "req-1",
    };
    const incident = await db.insertSosIncident(input);
    expect(incident.status).toBe("ACTIVE");

    await expect(db.insertSosIncident(input)).rejects.toSatisfy(isUniqueViolation);
    const existing = await db.findIncidentByClientRequestId(VALID_DEVICE_ID, "req-1");
    expect(existing?.id).toBe(incident.id);
  });

  it("lists nearby active incidents and hides terminal ones", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    await db.createDevice(VALID_DEVICE_ID_2);
    const base = {
      deviceId: VALID_DEVICE_ID,
      triggerType: "button" as const,
      locationAccuracy: null,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
    };
    const near = await db.insertSosIncident({
      ...base,
      latitude: POINT_B.lat,
      longitude: POINT_B.lon,
      clientRequestId: "near",
    });
    const far = await db.insertSosIncident({
      ...base,
      latitude: POINT_C.lat,
      longitude: POINT_C.lon,
      clientRequestId: "far",
    });
    await db.updateIncident(far.id, { status: "CANCELLED", cancelled_at: new Date().toISOString() });

    const found = await db.findNearbyActiveIncidents({
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      radiusMeters: 5000,
      maxResults: 50,
      excludeDeviceId: VALID_DEVICE_ID_2,
    });
    expect(found.map((r) => r.incidentId)).toEqual([near.id]);
  });

  it("scopes trusted contacts to the owning device", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    await db.createDevice(VALID_DEVICE_ID_2);
    const contact = await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Mom",
      phoneNumber: "+919900000001",
      priority: 1,
    });
    await expect(
      db.createTrustedContact({
        deviceId: VALID_DEVICE_ID,
        contactName: "Duplicate",
        phoneNumber: "+919900000001",
        priority: 2,
      }),
    ).rejects.toSatisfy(isUniqueViolation);

    const forOther = await db.listTrustedContacts(VALID_DEVICE_ID_2);
    expect(forOther).toEqual([]);

    // another device cannot delete it
    expect(await db.deleteTrustedContact(VALID_DEVICE_ID_2, contact.id)).toBe(false);
    expect(await db.deleteTrustedContact(VALID_DEVICE_ID, contact.id)).toBe(true);
    expect(await db.listTrustedContacts(VALID_DEVICE_ID)).toEqual([]);
  });

  it("tracks responders per incident with created flag", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    await db.createDevice(VALID_DEVICE_ID_2);
    const incident = await db.insertSosIncident({
      deviceId: VALID_DEVICE_ID,
      triggerType: "shake",
      latitude: POINT_A.lat,
      longitude: POINT_A.lon,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      clientRequestId: "r1",
    });

    const first = await db.insertIncidentResponderIfAbsent({
      incidentId: incident.id,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 1200,
      notifiedAt: new Date().toISOString(),
    });
    expect(first.created).toBe(true);
    expect(first.row.status).toBe("NOTIFIED");

    const second = await db.insertIncidentResponderIfAbsent({
      incidentId: incident.id,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 1200,
      notifiedAt: new Date().toISOString(),
    });
    expect(second.created).toBe(false);

    const accepted = await db.updateIncidentResponder(incident.id, VALID_DEVICE_ID_2, {
      status: "ACCEPTED",
      accepted_at: new Date().toISOString(),
    });
    expect(accepted.status).toBe("ACCEPTED");
    expect((await db.listIncidentResponders(incident.id)).length).toBe(1);
  });

  it("enforces call idempotency keys and reference uniqueness", async () => {
    await db.createDevice(VALID_DEVICE_ID);
    const incident = await db.insertSosIncident({
      deviceId: VALID_DEVICE_ID,
      triggerType: "button",
      latitude: null,
      longitude: null,
      locationAccuracy: null,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      clientRequestId: "c1",
    });

    await db.insertCallEvent({
      incidentId: incident.id,
      provider: "mock",
      callReference: "mock-1",
      idempotencyKey: "k1",
      recipientReference: "+9199",
      level: 1,
      status: "QUEUED",
    });
    await expect(
      db.insertCallEvent({
        incidentId: incident.id,
        provider: "mock",
        callReference: "mock-2",
        idempotencyKey: "k1",
        recipientReference: "+9199",
        level: 1,
        status: "QUEUED",
      }),
    ).rejects.toSatisfy(isUniqueViolation);

    const byKey = await db.findCallEventByIdempotencyKey("k1");
    expect(byKey?.call_reference).toBe("mock-1");
    const byRef = await db.findCallEventByReference("mock-1");
    expect(byRef?.idempotency_key).toBe("k1");
  });

  it("appends audit logs and responder events", async () => {
    await db.appendAuditLog({
      deviceId: VALID_DEVICE_ID,
      incidentId: null,
      eventType: "sos.created",
      data: { triggerType: "button" },
    });
    await db.appendResponderEvent({
      incidentId: "00000000-0000-4000-8000-000000000000",
      deviceId: VALID_DEVICE_ID_2,
      eventType: "ACCEPT",
      metadata: { from: "NOTIFIED" },
    });
    expect(db.getAuditLogs()).toHaveLength(1);
    expect(db.getAuditLogs()[0]!.event_type).toBe("sos.created");
    expect(db.getResponderEvents()).toHaveLength(1);
  });

  it("haversine distances match known city scales", () => {
    // MG Road -> Shivajinagar-ish short hop (~1.6-1.7 km)
    const d = haversineMeters(POINT_A.lat, POINT_A.lon, POINT_B.lat, POINT_B.lon);
    expect(d).toBeGreaterThan(1400);
    expect(d).toBeLessThan(2000);
  });
});
