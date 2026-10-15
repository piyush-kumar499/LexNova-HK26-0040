import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeTestApp,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  VALID_DEVICE_ID_3,
  type TestApp,
} from "./helpers/setup.js";
import { hmacSha256Hex } from "../src/utils/crypto.js";

/**
 * Spec §15 critical path — one named test per scenario, in the order the
 * spec lists them. Detailed edge cases live in the feature-specific suites;
 * this file proves the whole loop end to end.
 */

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const SECOND = { "x-device-id": VALID_DEVICE_ID_2 };
const THIRD = { "x-device-id": VALID_DEVICE_ID_3 };
const FRESH_DEVICE = "9c858901-8a57-4791-81fe-4c455b099bc9";

/** Delhi reference point; 1 degree of latitude ≈ 111.2 km. */
const BASE = { latitude: 28.6139, longitude: 77.209 };
const LAT_PER_METER = 1 / 111_194.93;

function sosBody(clientRequestId: string, lat = BASE.latitude, lng = BASE.longitude) {
  return {
    triggerType: "button",
    latitude: lat,
    longitude: lng,
    locationAccuracy: 10,
    deviceTimestamp: new Date().toISOString(),
    clientRequestId,
  };
}

async function createSos(
  app: TestApp["app"],
  headers: Record<string, string>,
  clientRequestId: string,
  lat = BASE.latitude,
  lng = BASE.longitude,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sos",
    headers,
    payload: sosBody(clientRequestId, lat, lng),
  });
  expect(res.statusCode).toBe(201);
  return res.json().incident.id as string;
}

function poll(app: TestApp["app"], headers: Record<string, string>, offsetMeters: number) {
  const qs = new URLSearchParams({
    latitude: String(BASE.latitude + offsetMeters * LAT_PER_METER),
    longitude: String(BASE.longitude),
    radiusMeters: "2000",
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

describe("§15 Critical path", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("1. Device auto-registration on first request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/device/me",
      headers: { "x-device-id": FRESH_DEVICE },
    });

    expect(res.statusCode).toBe(200);
    const device = res.json().device;
    expect(device.deviceId).toBe(FRESH_DEVICE);
    expect(device.canRespond).toBe(true);
    expect(device.isActive).toBe(true);
    expect(device.displayName).toBeNull();

    const registered = db
      .getAuditLogs()
      .find((entry) => entry.event_type === "device.registered");
    expect(registered?.device_id).toBe(FRESH_DEVICE);
  });

  it("2. Invalid device ID rejection", async () => {
    const missing = await app.inject({ method: "GET", url: "/device/me" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("MISSING_DEVICE_ID");

    for (const bad of ["hello-world", "6f9619ff-8b86-1d01-b42d-00cf4fc964ff"]) {
      const res = await app.inject({
        method: "GET",
        url: "/device/me",
        headers: { "x-device-id": bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_DEVICE_ID");
    }
  });

  it("3. SOS creation with a valid device ID", async () => {
    const deviceTimestamp = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: { ...sosBody("critical-create-1"), deviceTimestamp },
    });

    expect(res.statusCode).toBe(201);
    const { incident, created } = res.json();
    expect(created).toBe(true);
    expect(incident.status).toBe("ACTIVE");
    expect(incident.activatedAt).toBe(deviceTimestamp);

    const stored = await db.getIncident(incident.id);
    expect(stored?.device_id).toBe(VALID_DEVICE_ID);
    expect(stored?.latitude).toBeCloseTo(BASE.latitude);
  });

  it("4. Duplicate SOS with the same clientRequestId", async () => {
    const payload = sosBody("critical-dup-1");
    const first = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    const second = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().incident.id).toBe(first.json().incident.id);
    expect(
      db
        .getAuditLogs()
        .some(
          (entry) =>
            entry.incident_id === first.json().incident.id &&
            entry.event_type === "sos.duplicate_replayed",
        ),
    ).toBe(true);
  });

  it("5. Invalid state transition rejection", async () => {
    // Resolve requires an acknowledged responder — rejected both from ACTIVE
    // and from HELP_REQUESTED (whichever the async pipeline has reached).
    const toResolve = await createSos(app, OWNER, "critical-transition-1");
    const badResolve = await app.inject({
      method: "POST",
      url: `/sos/${toResolve}/resolve`,
      headers: OWNER,
      payload: { resolutionReason: "all good" },
    });
    expect(badResolve.statusCode).toBe(409);
    expect(badResolve.json().error.code).toBe("INVALID_STATE_TRANSITION");

    // Cancelling twice: the second cancel hits a terminal state.
    const toCancel = await createSos(app, OWNER, "critical-transition-2");
    const cancel = await app.inject({
      method: "POST",
      url: `/sos/${toCancel}/cancel`,
      headers: OWNER,
      payload: { reason: "false alarm" },
    });
    expect(cancel.statusCode).toBe(200);

    const again = await app.inject({
      method: "POST",
      url: `/sos/${toCancel}/cancel`,
      headers: OWNER,
      payload: { reason: "false alarm" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("6. Vapi webhook signature verification", async () => {
    const secret = "critical-path-webhook-secret";
    const { app: webhookApp } = makeTestApp({ VAPI_WEBHOOK_SECRET: secret });
    await webhookApp.ready();

    const body = JSON.stringify({
      message: { type: "status-update", status: "ringing", call: { id: "critical-call-1" } },
    });

    const unsigned = await webhookApp.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.code).toBe("INVALID_WEBHOOK_SIGNATURE");

    const wrongSignature = await webhookApp.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: { "content-type": "application/json", "x-vapi-signature": "0".repeat(64) },
      payload: body,
    });
    expect(wrongSignature.statusCode).toBe(401);

    const signed = await webhookApp.inject({
      method: "POST",
      url: "/vapi/webhook",
      headers: {
        "content-type": "application/json",
        "x-vapi-signature": hmacSha256Hex(secret, body),
      },
      payload: body,
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toEqual({ received: true });

    await webhookApp.close();
  });

  it("7. Escalation triggered on an unanswered call", async () => {
    const { app: noAnswerApp, db: noAnswerDb } = makeTestApp({
      MOCK_VAPI_OUTCOME: "no-answer",
    });
    await noAnswerDb.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "First",
      phoneNumber: "+919999400001",
      priority: 1,
    });
    await noAnswerDb.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Second",
      phoneNumber: "+919999400002",
      priority: 2,
    });
    await noAnswerApp.ready();

    const incidentId = await createSos(noAnswerApp, OWNER, "critical-escalation-1");

    // The unanswered call to the first contact moves the chain to the second.
    await waitFor(async () => (await noAnswerDb.listCallEvents(incidentId)).length === 2);
    const events = await noAnswerDb.listCallEvents(incidentId);
    expect(events[0]?.recipient_reference).toBe("+919999400001");
    expect(events[0]?.status).toBe("NO_ANSWER");
    expect(events[1]?.recipient_reference).toBe("+919999400002");

    await noAnswerApp.close();
  });

  it("8. Offline event posted after reconnect", async () => {
    const activatedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    const payload = { ...sosBody("critical-offline-1"), deviceTimestamp: activatedAt };

    const res = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    expect(res.statusCode).toBe(201);
    // The activation time is the on-device time, not the reconnect time (§14).
    expect(res.json().incident.activatedAt).toBe(activatedAt);

    // The app lost the response and re-sends the queued event once more.
    const replay = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().incident.id).toBe(res.json().incident.id);
  });

  it("9. Rate limit enforcement", async () => {
    const { app: limitedApp } = makeTestApp({ RATE_LIMIT_MAX: "2" });
    await limitedApp.ready();

    const hit = (n: number) =>
      limitedApp.inject({
        method: "POST",
        url: "/sos",
        headers: OWNER,
        payload: sosBody(`critical-ratelimit-${n}`),
      });

    expect((await hit(1)).statusCode).toBe(201);
    expect((await hit(2)).statusCode).toBe(201);

    const third = await hit(3);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    expect(third.headers["retry-after"]).toBeDefined();

    await limitedApp.close();
  });

  it("10. Idempotent Vapi call", async () => {
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Idempotency",
      phoneNumber: "+919999400010",
      priority: 1,
    });
    const incidentId = await createSos(app, OWNER, "critical-idempotent-1");

    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);
    const incident = await db.getIncident(incidentId);
    expect(incident).not.toBeNull();

    // Re-issuing the same attempt (same recipient, level, attempt) must not
    // dial again — the idempotency key absorbs it.
    await app.ctx.escalation.notifyRecipient(
      incident!,
      {
        recipientType: "trusted_contact",
        reference: "+919999400010",
        toNumber: "+919999400010",
        distanceM: null,
        label: "Idempotency",
      },
      1,
    );
    expect(await db.listCallEvents(incidentId)).toHaveLength(1);
  });

  it("11. Nearby device search returns correct distances", async () => {
    const incidentId = await createSos(app, OWNER, "critical-distance-1");
    await waitFor(async () => (await db.getIncident(incidentId))?.status === "HELP_REQUESTED");

    // Poll from ~222 m away — reported as 200 m after 100 m rounding.
    const near = await poll(app, SECOND, 222);
    expect(near.statusCode).toBe(200);
    const nearItem = near
      .json()
      .incidents.find((i: { incidentId: string }) => i.incidentId === incidentId);
    expect(nearItem.approximateDistanceM).toBe(200);

    // Poll from ~456 m away — reported as 500 m.
    const far = await poll(app, SECOND, 456);
    const farItem = far
      .json()
      .incidents.find((i: { incidentId: string }) => i.incidentId === incidentId);
    expect(farItem.approximateDistanceM).toBe(500);
  });

  it("12. Nearby device cannot see exact location before accepting", async () => {
    const incidentId = await createSos(app, OWNER, "critical-privacy-1");
    await waitFor(async () => (await db.getIncident(incidentId))?.status === "HELP_REQUESTED");

    const seen = await poll(app, THIRD, 111);
    expect(seen.statusCode).toBe(200);
    const item = seen
      .json()
      .incidents.find((i: { incidentId: string }) => i.incidentId === incidentId);
    expect(item.responderStatus).toBe("NOTIFIED");
    // The pre-accept payload carries an approximate distance and no coordinates.
    expect(JSON.stringify(seen.json())).not.toMatch(/"(latitude|longitude)"/);

    // Even the incident detail endpoint refuses before acceptance.
    const detail = await app.inject({
      method: "GET",
      url: `/sos/${incidentId}`,
      headers: THIRD,
    });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().error.code).toBe("RESPONDER_NOT_ACCEPTED");

    // After accepting, the exact location is visible to the responder.
    const accepted = await respond(app, THIRD, incidentId, "ACCEPT");
    expect(accepted.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/sos/${incidentId}`,
      headers: THIRD,
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().location.latitude).toBeCloseTo(BASE.latitude);
    expect(after.json().location.longitude).toBeCloseTo(BASE.longitude);
  });

  it("13. Same device: seeker in one incident, responder in another — no role change", async () => {
    // X asks for help in incident A…
    const incidentA = await createSos(app, OWNER, "critical-dual-A");
    // …while Y asks for help in incident B, ~300 m away.
    const incidentB = await createSos(
      app,
      SECOND,
      "critical-dual-B",
      BASE.latitude + 300 * LAT_PER_METER,
    );
    await waitFor(async () => {
      const [a, b] = await Promise.all([db.getIncident(incidentA), db.getIncident(incidentB)]);
      return a?.status === "HELP_REQUESTED" && b?.status === "HELP_REQUESTED";
    });

    // X polls as a nearby helper: it sees B (Y's incident) but never its own A.
    const seen = await poll(app, OWNER, 0);
    expect(seen.statusCode).toBe(200);
    expect(
      seen.json().incidents.some((i: { incidentId: string }) => i.incidentId === incidentB),
    ).toBe(true);
    expect(
      seen.json().incidents.some((i: { incidentId: string }) => i.incidentId === incidentA),
    ).toBe(false);

    // X accepts B and becomes a responder there…
    const accepted = await respond(app, OWNER, incidentB, "ACCEPT");
    expect(accepted.statusCode).toBe(200);

    // …while remaining the owner (seeker) of A. Two roles, one device, and
    // no stored role anywhere — roles are per incident (devices have no
    // "role" column by design).
    const viewA = await app.inject({ method: "GET", url: `/sos/${incidentA}`, headers: OWNER });
    expect(viewA.statusCode).toBe(200);
    expect(viewA.json().viewer.role).toBe("OWNER");

    const viewB = await app.inject({ method: "GET", url: `/sos/${incidentB}`, headers: OWNER });
    expect(viewB.statusCode).toBe(200);
    expect(viewB.json().viewer).toEqual({ role: "RESPONDER", responderStatus: "ACCEPTED" });

    const device = await db.getDeviceByDeviceId(VALID_DEVICE_ID);
    expect(device).not.toBeNull();
    expect(device).not.toHaveProperty("role");
    expect(device?.can_respond).toBe(true);

    const rowA = await db.getIncident(incidentA);
    const rowB = await db.getIncident(incidentB);
    expect(rowA?.device_id).toBe(VALID_DEVICE_ID);
    expect(rowB?.device_id).toBe(VALID_DEVICE_ID_2);
    expect((await db.getIncidentResponder(incidentB, VALID_DEVICE_ID))?.status).toBe("ACCEPTED");
  });
});
