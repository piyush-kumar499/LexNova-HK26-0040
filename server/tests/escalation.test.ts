import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryDatabase } from "../src/services/memory.service.js";
import {
  makeTestApp,
  makeTestConfig,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  type TestApp,
} from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };

/** Delhi reference point; 1 degree of latitude ≈ 111.2 km. */
const BASE = { latitude: 28.6139, longitude: 77.209 };

function sosBody(clientRequestId: string): Record<string, unknown> {
  return {
    triggerType: "button",
    latitude: BASE.latitude,
    longitude: BASE.longitude,
    locationAccuracy: 10,
    deviceTimestamp: new Date().toISOString(),
    clientRequestId,
  };
}

async function seedOpenIncident(
  db: MemoryDatabase,
  options: {
    clientRequestId: string;
    status?: "ACTIVE" | "HELP_REQUESTED";
    withLocation?: boolean;
  },
): Promise<string> {
  const withLocation = options.withLocation ?? true;
  const incident = await db.insertSosIncident({
    deviceId: VALID_DEVICE_ID,
    triggerType: "button",
    latitude: withLocation ? BASE.latitude : null,
    longitude: withLocation ? BASE.longitude : null,
    locationAccuracy: withLocation ? 10 : null,
    deviceTimestamp: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    clientRequestId: options.clientRequestId,
  });
  if (options.status === "HELP_REQUESTED") {
    await db.updateIncident(incident.id, { status: "HELP_REQUESTED", escalation_level: 1 });
  }
  return incident.id;
}

describe("Escalation chains", () => {
  it("with no answer, walks contacts → nearby devices → explicit exhaustion", async () => {
    const { app, db }: TestApp = makeTestApp({ MOCK_VAPI_OUTCOME: "no-answer" });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999100001",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Neighbour",
      phoneNumber: "+919999100002",
      priority: 2,
    });
    // A community responder with a phone number, ~111 m north of the incident.
    db.seedDevice(VALID_DEVICE_ID_2, {
      phone_number: "+919999100003",
      display_name: "Ravi",
    });
    db.seedDeviceLocation(VALID_DEVICE_ID_2, BASE.latitude + 0.001, BASE.longitude);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("esc-chain-1"),
    });
    const incidentId = created.json().incident.id;

    // The whole chain settles at exhaustion: contacts, then the nearby device.
    await waitFor(
      () =>
        db
          .getAuditLogs()
          .some(
            (entry) =>
              entry.incident_id === incidentId && entry.event_type === "escalation.exhausted",
          ),
      4000,
    );

    const events = await db.listCallEvents(incidentId);
    expect(events.map((event) => [event.recipient_reference, event.level, event.status])).toEqual([
      ["+919999100001", 1, "NO_ANSWER"],
      ["+919999100002", 1, "NO_ANSWER"],
      [`device:${VALID_DEVICE_ID_2}`, 2, "NO_ANSWER"],
    ]);

    const recipients = await db.listIncidentRecipients(incidentId);
    expect(
      recipients.map((row) => [row.recipient_type, row.recipient_reference, row.delivery_status]),
    ).toEqual([
      ["trusted_contact", "+919999100001", "FAILED"],
      ["trusted_contact", "+919999100002", "FAILED"],
      ["nearby_device", `device:${VALID_DEVICE_ID_2}`, "FAILED"],
    ]);

    // The nearby device is a NOTIFIED community responder with its distance recorded.
    const responder = await db.getIncidentResponder(incidentId, VALID_DEVICE_ID_2);
    expect(responder?.status).toBe("NOTIFIED");
    expect(responder?.distance_at_notify_m).toBeGreaterThan(100);
    expect(responder?.distance_at_notify_m).toBeLessThan(120);

    const incident = await db.getIncident(incidentId);
    expect(incident?.status).toBe("HELP_REQUESTED");
    // Level 3 swept its wider radius but found no NEW recipients (the device
    // was already dialed at level 2), so the last level that did work is 2.
    expect(incident?.escalation_level).toBe(2);

    // Exhaustion is stated honestly — no emergency service was ever dialed.
    const exhausted = db
      .getAuditLogs()
      .find(
        (entry) => entry.incident_id === incidentId && entry.event_type === "escalation.exhausted",
      );
    expect((exhausted?.event_data as Record<string, unknown>)?.maxLevel).toBe(3);

    await app.close();
  });

  it("never dials a number twice across levels", async () => {
    const { app, db }: TestApp = makeTestApp({ MOCK_VAPI_OUTCOME: "no-answer" });
    // The nearby device's phone is also a trusted contact number.
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Shared Phone",
      phoneNumber: "+919999100004",
      priority: 1,
    });
    db.seedDevice(VALID_DEVICE_ID_2, { phone_number: "+919999100004" });
    db.seedDeviceLocation(VALID_DEVICE_ID_2, BASE.latitude + 0.001, BASE.longitude);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody("esc-dedupe-1"),
    });
    const incidentId = created.json().incident.id;

    await waitFor(
      () =>
        db
          .getAuditLogs()
          .some(
            (entry) =>
              entry.incident_id === incidentId && entry.event_type === "escalation.exhausted",
          ),
      4000,
    );

    const events = await db.listCallEvents(incidentId);
    expect(events).toHaveLength(1);
    expect(events[0]?.recipient_reference).toBe("+919999100004");
    expect(events[0]?.level).toBe(1);

    await app.close();
  });

  it("stops escalating once a responder has accepted", async () => {
    const config = makeTestConfig();
    const db = new MemoryDatabase();
    const incidentId = await seedOpenIncident(db, {
      clientRequestId: "esc-accepted-1",
      status: "HELP_REQUESTED",
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999100005",
      priority: 1,
    });
    const notifiedAt = new Date().toISOString();
    await db.insertIncidentResponderIfAbsent({
      incidentId,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 100,
      notifiedAt,
    });
    await db.updateIncidentResponder(incidentId, VALID_DEVICE_ID_2, {
      status: "ACCEPTED",
      accepted_at: notifiedAt,
    });

    const app = buildApp({ config, db });
    await app.ready();
    await app.ctx.escalation.rehydrateOpenIncidents();

    expect(await db.listCallEvents(incidentId)).toEqual([]);
    await app.close();
  });

  it("rehydrates an incident whose pipeline never ran (still ACTIVE)", async () => {
    const config = makeTestConfig();
    const db = new MemoryDatabase();
    const incidentId = await seedOpenIncident(db, { clientRequestId: "esc-rehydrate-active" });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999100010",
      priority: 1,
    });

    const app = buildApp({ config, db });
    await app.ready();
    await app.ctx.escalation.rehydrateOpenIncidents();

    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);
    const fresh = await db.getIncident(incidentId);
    expect(fresh?.status).toBe("HELP_REQUESTED");
    const [call] = await db.listCallEvents(incidentId);
    expect(call?.recipient_reference).toBe("+919999100010");
    expect(call?.status).toBe("ANSWERED"); // default mock outcome

    await app.close();
  });

  it("rehydration moves past a terminal attempt to the next contact", async () => {
    const config = makeTestConfig();
    const db = new MemoryDatabase();
    const incidentId = await seedOpenIncident(db, {
      clientRequestId: "esc-rehydrate-terminal",
      status: "HELP_REQUESTED",
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "First",
      phoneNumber: "+919999100011",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Second",
      phoneNumber: "+919999100012",
      priority: 2,
    });
    await db.insertCallEvent({
      incidentId,
      provider: "mock",
      callReference: null,
      idempotencyKey: `incident:${incidentId}:recipient:+919999100011:level:1:attempt:1`,
      recipientReference: "+919999100011",
      level: 1,
      status: "NO_ANSWER",
    });

    const app = buildApp({ config, db });
    await app.ready();
    await app.ctx.escalation.rehydrateOpenIncidents();

    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 2);
    const events = await db.listCallEvents(incidentId);
    expect(events[1]?.recipient_reference).toBe("+919999100012");
    expect(events[1]?.status).toBe("ANSWERED");

    await app.close();
  });

  it("watchdog advances an in-flight attempt after the configured timeout", async () => {
    const config = makeTestConfig({ SOS_ESCALATION_TIMEOUT_SECONDS: "1" });
    const db = new MemoryDatabase();
    const incidentId = await seedOpenIncident(db, {
      clientRequestId: "esc-watchdog-1",
      status: "HELP_REQUESTED",
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "First",
      phoneNumber: "+919999100021",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Second",
      phoneNumber: "+919999100022",
      priority: 2,
    });
    await db.insertCallEvent({
      incidentId,
      provider: "vapi",
      callReference: "vapi-call-stuck",
      idempotencyKey: `incident:${incidentId}:recipient:+919999100021:level:1:attempt:1`,
      recipientReference: "+919999100021",
      level: 1,
      status: "QUEUED",
    });

    const app = buildApp({ config, db });
    await app.ready();
    // The interrupted process left a queued attempt with no webhook coming.
    await app.ctx.escalation.rehydrateOpenIncidents();

    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 2, 4000);
    const events = await db.listCallEvents(incidentId);
    expect(events[1]?.recipient_reference).toBe("+919999100022");
    expect(
      db
        .getAuditLogs()
        .some(
          (entry) =>
            entry.incident_id === incidentId && entry.event_type === "escalation.call_timeout",
        ),
    ).toBe(true);

    await app.close();
  });
});
