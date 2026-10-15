import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryDatabase } from "../src/services/memory.service.js";
import {
  makeTestApp,
  makeTestConfig,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  VALID_DEVICE_ID_3,
  type TestApp,
} from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const RESPONDER = { "x-device-id": VALID_DEVICE_ID_2 };
const SECOND_RESPONDER = { "x-device-id": VALID_DEVICE_ID_3 };
const STRAY = { "x-device-id": "9c858901-8a57-4791-81fe-4c455b099bc9" };

/** Delhi reference point; 1 degree of latitude ≈ 111.2 km. */
const BASE = { latitude: 28.6139, longitude: 77.209 };
const LAT_PER_METER = 1 / 111_194.93;

async function waitForDispatch(db: TestApp["db"], incidentId: string): Promise<void> {
  await waitFor(async () => (await db.getIncident(incidentId))?.status === "HELP_REQUESTED");
}

async function createIncident(app: TestApp["app"], headers: Record<string, string>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sos",
    headers,
    payload: {
      triggerType: "button",
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      clientRequestId: `responder-${Math.random().toString(36).slice(2, 12)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().incident.id as string;
}

function poll(
  app: TestApp["app"],
  headers: Record<string, string>,
  offsetMeters = 111,
) {
  const qs = new URLSearchParams({
    latitude: String(BASE.latitude + offsetMeters * LAT_PER_METER),
    longitude: String(BASE.longitude),
  }).toString();
  return app.inject({ method: "GET", url: `/nearby/sos?${qs}`, headers });
}

function respond(
  app: TestApp["app"],
  headers: Record<string, string>,
  incidentId: string,
  action: string,
) {
  return app.inject({
    method: "POST",
    url: `/sos/${incidentId}/respond`,
    headers,
    payload: { action },
  });
}

describe("Responder actions", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts an alert from a notified nearby device", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    const seen = await poll(app, RESPONDER);
    expect(seen.statusCode).toBe(200);
    expect(
      seen.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId)
        .responderStatus,
    ).toBe("NOTIFIED");

    const res = await respond(app, RESPONDER, incidentId, "ACCEPT");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incident.status).toBe("RESPONDER_ACKNOWLEDGED");
    expect(body.responder.status).toBe("ACCEPTED");
    expect(body.responder.acceptedAt).toBeTruthy();
    expect(body.responder.notifiedAt).toBeTruthy();

    const membership = await db.getIncidentResponder(incidentId, VALID_DEVICE_ID_2);
    expect(membership?.status).toBe("ACCEPTED");

    const events = db
      .getResponderEvents()
      .filter(
        (event) =>
          event.incident_id === incidentId &&
          event.device_id === VALID_DEVICE_ID_2 &&
          event.event_type === "responder.accept",
      );
    expect(events).toHaveLength(1);

    const audits = db
      .getAuditLogs()
      .filter((entry) => entry.incident_id === incidentId)
      .map((entry) => entry.event_type);
    expect(audits).toContain("sos.responder_action");
    expect(audits).toContain("sos.responder_acknowledged");

    const fresh = await db.getIncident(incidentId);
    expect(fresh?.status).toBe("RESPONDER_ACKNOWLEDGED");
  });

  it("walks EN_ROUTE then ARRIVED with per-step timestamps", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);
    await poll(app, RESPONDER);

    const accepted = await respond(app, RESPONDER, incidentId, "ACCEPT");
    expect(accepted.statusCode).toBe(200);

    const enRoute = await respond(app, RESPONDER, incidentId, "EN_ROUTE");
    expect(enRoute.statusCode).toBe(200);
    expect(enRoute.json().responder.status).toBe("EN_ROUTE");
    expect(enRoute.json().responder.enRouteAt).toBeTruthy();
    expect(enRoute.json().responder.arrivedAt).toBeNull();

    const arrived = await respond(app, RESPONDER, incidentId, "ARRIVED");
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().responder.status).toBe("ARRIVED");
    expect(arrived.json().responder.arrivedAt).toBeTruthy();

    const eventTypes = db
      .getResponderEvents()
      .filter((event) => event.incident_id === incidentId && event.device_id === VALID_DEVICE_ID_2)
      .map((event) => event.event_type);
    expect(eventTypes).toEqual([
      "responder.nearby_notified",
      "responder.accept",
      "responder.en_route",
      "responder.arrived",
    ]);
  });

  it("keeps incident details hidden until the responder accepts", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);
    await poll(app, RESPONDER);

    const before = await app.inject({
      method: "GET",
      url: `/sos/${incidentId}`,
      headers: RESPONDER,
    });
    expect(before.statusCode).toBe(403);
    expect(before.json().error.code).toBe("RESPONDER_NOT_ACCEPTED");

    await respond(app, RESPONDER, incidentId, "ACCEPT");

    const after = await app.inject({
      method: "GET",
      url: `/sos/${incidentId}`,
      headers: RESPONDER,
    });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.viewer).toEqual({ role: "RESPONDER", responderStatus: "ACCEPTED" });
    // Accepted responders see the exact location…
    expect(body.location).toEqual({
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      accuracy: 10,
    });
    // …but never evidence or call detail (spec §5.5).
    expect(body.evidence).toEqual([]);
    expect(body.calls).toEqual([]);
  });

  it("rejects devices that were never notified for the incident", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    const res = await respond(app, STRAY, incidentId, "ACCEPT");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NOT_A_RESPONDER");

    const detail = await app.inject({
      method: "GET",
      url: `/sos/${incidentId}`,
      headers: STRAY,
    });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects responding to a closed incident", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    const cancelled = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: { reason: "false alarm" },
    });
    expect(cancelled.statusCode).toBe(200);

    const res = await respond(app, RESPONDER, incidentId, "ACCEPT");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INCIDENT_CLOSED");
    expect(res.json().error.details).toEqual({ status: "CANCELLED" });
  });

  it("rejects illegal responder transitions with 409", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);
    await poll(app, RESPONDER);

    // NOTIFIED can only ACCEPT or DECLINE.
    const jump = await respond(app, RESPONDER, incidentId, "ARRIVED");
    expect(jump.statusCode).toBe(409);
    expect(jump.json().error.code).toBe("INVALID_RESPONDER_TRANSITION");
    expect(jump.json().error.details).toEqual({ from: "NOTIFIED", to: "ARRIVED" });

    expect((await respond(app, RESPONDER, incidentId, "ACCEPT")).statusCode).toBe(200);

    // ACCEPTED cannot ACCEPT again.
    const again = await respond(app, RESPONDER, incidentId, "ACCEPT");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INVALID_RESPONDER_TRANSITION");

    expect((await respond(app, RESPONDER, incidentId, "WITHDRAW")).statusCode).toBe(200);

    // WITHDRAWN is terminal.
    const after = await respond(app, RESPONDER, incidentId, "EN_ROUTE");
    expect(after.statusCode).toBe(409);
    expect(after.json().error.code).toBe("INVALID_RESPONDER_TRANSITION");
  });

  it("records a decline and marks the call recipient as declined", async () => {
    // The nearby device has a phone, so the chain dials it — the dial itself
    // creates the membership and the nearby_device recipient row.
    db.seedDevice(VALID_DEVICE_ID_2, { phone_number: "+919999200002" });
    db.seedDeviceLocation(VALID_DEVICE_ID_2, BASE.latitude + 0.001, BASE.longitude);

    const incidentId = await createIncident(app, OWNER);
    await waitFor(async () => (await db.getIncidentResponder(incidentId, VALID_DEVICE_ID_2)) !== null);

    const res = await respond(app, RESPONDER, incidentId, "DECLINE");
    expect(res.statusCode).toBe(200);
    expect(res.json().responder.status).toBe("DECLINED");
    expect(res.json().responder.declinedAt).toBeTruthy();

    const recipients = await db.listIncidentRecipients(incidentId);
    const mine = recipients.find(
      (row) => row.recipient_reference === `device:${VALID_DEVICE_ID_2}`,
    );
    expect(mine?.delivery_status).toBe("DECLINED");

    const events = db
      .getResponderEvents()
      .filter(
        (event) =>
          event.incident_id === incidentId &&
          event.device_id === VALID_DEVICE_ID_2 &&
          event.event_type === "responder.decline",
      );
    expect(events).toHaveLength(1);
  });

  it("allows a second responder to accept the same incident", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    expect((await poll(app, RESPONDER)).statusCode).toBe(200);
    expect((await respond(app, RESPONDER, incidentId, "ACCEPT")).statusCode).toBe(200);

    const otherPoll = await poll(app, SECOND_RESPONDER, 222);
    expect(otherPoll.statusCode).toBe(200);
    expect(
      otherPoll.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId)
        .responderStatus,
    ).toBe("NOTIFIED");

    const second = await respond(app, SECOND_RESPONDER, incidentId, "ACCEPT");
    expect(second.statusCode).toBe(200);
    expect(second.json().responder.status).toBe("ACCEPTED");
    expect(second.json().incident.status).toBe("RESPONDER_ACKNOWLEDGED");

    const memberships = await db.listIncidentResponders(incidentId);
    const byDevice = Object.fromEntries(memberships.map((row) => [row.device_id, row.status]));
    expect(byDevice).toEqual({
      [VALID_DEVICE_ID_2]: "ACCEPTED",
      [VALID_DEVICE_ID_3]: "ACCEPTED",
    });
  });

  it("resumes the escalation chain when the responder withdraws", async () => {
    const db = new MemoryDatabase();
    const incident = await db.insertSosIncident({
      deviceId: VALID_DEVICE_ID,
      triggerType: "button",
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      clientRequestId: "responder-withdraw-1",
    });
    await db.updateIncident(incident.id, { status: "HELP_REQUESTED", escalation_level: 1 });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Amma",
      phoneNumber: "+919999300001",
      priority: 1,
    });
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Neighbour",
      phoneNumber: "+919999300002",
      priority: 2,
    });
    // Contact one was dialed and never answered before the responder accepted.
    await db.insertCallEvent({
      incidentId: incident.id,
      provider: "mock",
      callReference: null,
      idempotencyKey: `incident:${incident.id}:recipient:+919999300001:level:1:attempt:1`,
      recipientReference: "+919999300001",
      level: 1,
      status: "NO_ANSWER",
    });
    await db.insertIncidentResponderIfAbsent({
      incidentId: incident.id,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 120,
      notifiedAt: new Date().toISOString(),
    });

    const app = buildApp({ config: makeTestConfig(), db });
    await app.ready();

    const accepted = await respond(app, RESPONDER, incident.id, "ACCEPT");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().incident.status).toBe("RESPONDER_ACKNOWLEDGED");
    // Help is on the way: no further calls while the responder is engaged.
    expect(await db.listCallEvents(incident.id)).toHaveLength(1);

    const withdrawn = await respond(app, RESPONDER, incident.id, "WITHDRAW");
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().responder.status).toBe("WITHDRAWN");

    // The chain resumes from the last attempt: the second contact is dialed.
    await waitFor(async () => (await db.listCallEvents(incident.id)).length === 2);
    const events = await db.listCallEvents(incident.id);
    expect(events[1]?.recipient_reference).toBe("+919999300002");
    expect(events[1]?.status).toBe("ANSWERED");

    const fresh = await db.getIncident(incident.id);
    expect(fresh?.status).toBe("RESPONDER_ACKNOWLEDGED");

    await app.close();
  });
});
