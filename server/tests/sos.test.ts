import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, VALID_DEVICE_ID, VALID_DEVICE_ID_2, VALID_DEVICE_ID_3, type TestApp } from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const OTHER = { "x-device-id": VALID_DEVICE_ID_2 };

function sosBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    triggerType: "button",
    latitude: 28.6139,
    longitude: 77.209,
    locationAccuracy: 10,
    deviceTimestamp: "2026-10-14T09:00:00.000Z",
    clientRequestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    ...overrides,
  };
}

describe("SOS endpoints", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /sos creates an ACTIVE incident and returns it immediately", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "create-1" }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.incident.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.incident.status).toBe("ACTIVE");
    expect(body.incident.triggerType).toBe("button");
    // Offline-queued semantics: activated_at is the device timestamp (§14).
    expect(body.incident.activatedAt).toBe("2026-10-14T09:00:00.000Z");

    const stored = await db.getIncident(body.incident.id);
    expect(stored?.device_id).toBe(VALID_DEVICE_ID);
    expect(stored?.latitude).toBeCloseTo(28.6139);

    const audit = db.getAuditLogs().filter((e) => e.event_type === "sos.created");
    expect(audit.some((e) => e.incident_id === body.incident.id)).toBe(true);
  });

  it("POST /sos replays the same incident for a duplicate clientRequestId", async () => {
    const payload = sosBody({ clientRequestId: "dup-1" });
    const first = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    const second = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().incident.id).toBe(first.json().incident.id);
  });

  it("POST /sos creates a new incident for a new clientRequestId", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "distinct-1" }),
    });
    const second = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "distinct-2" }),
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().incident.id).not.toBe(first.json().incident.id);
  });

  it("POST /sos falls back to the device's latest stored location", async () => {
    await app.inject({
      method: "POST",
      url: "/device/location",
      headers: OWNER,
      payload: {
        latitude: 19.076,
        longitude: 72.8777,
        accuracy: 20,
        capturedAt: new Date().toISOString(),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({
        clientRequestId: "fallback-1",
        latitude: undefined,
        longitude: undefined,
        locationAccuracy: undefined,
      }),
    });

    expect(res.statusCode).toBe(201);
    const stored = await db.getIncident(res.json().incident.id);
    expect(stored?.latitude).toBeCloseTo(19.076);
    expect(stored?.longitude).toBeCloseTo(72.8777);
  });

  it("POST /sos still records an incident without any location", async () => {
    await app.inject({
      method: "POST",
      url: "/sos",
      headers: OTHER,
      payload: sosBody({
        clientRequestId: "no-location-1",
        latitude: undefined,
        longitude: undefined,
        locationAccuracy: undefined,
      }),
    });

    const stored = await db.findIncidentByClientRequestId(VALID_DEVICE_ID_2, "no-location-1");
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("ACTIVE");
    expect(stored?.latitude).toBeNull();
  });

  it("POST /sos rejects invalid payloads", async () => {
    const badTrigger = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ triggerType: "scream" }),
    });
    expect(badTrigger.statusCode).toBe(400);
    expect(badTrigger.json().error.code).toBe("VALIDATION_ERROR");

    const missingId = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: undefined }),
    });
    expect(missingId.statusCode).toBe(400);

    const halfCoordinates = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ longitude: undefined }),
    });
    expect(halfCoordinates.statusCode).toBe(400);
  });

  it("GET /sos/:incidentId gives the owner the full incident view", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "owner-view-1" }),
    });
    const incidentId = created.json().incident.id;

    const res = await app.inject({ method: "GET", url: `/sos/${incidentId}`, headers: OWNER });

    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.viewer.role).toBe("OWNER");
    expect(view.incident.id).toBe(incidentId);
    expect(view.location.latitude).toBeCloseTo(28.6139);
    expect(view.evidence).toEqual([]);
    expect(view.responders).toEqual([]);
    expect(view.calls).toEqual([]);
  });

  it("GET /sos/:incidentId refuses devices with no relationship to the incident", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "privacy-1" }),
    });
    const incidentId = created.json().incident.id;

    const res = await app.inject({ method: "GET", url: `/sos/${incidentId}`, headers: OTHER });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(res.body).not.toContain("28.6139");
  });

  it("GET /sos/:incidentId hides exact location from a NOTIFIED responder", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "notified-1" }),
    });
    const incidentId = created.json().incident.id;

    await app.inject({ method: "GET", url: "/device/me", headers: OTHER }); // register
    await db.insertIncidentResponderIfAbsent({
      incidentId,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 800,
      notifiedAt: new Date().toISOString(),
    });

    const res = await app.inject({ method: "GET", url: `/sos/${incidentId}`, headers: OTHER });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("RESPONDER_NOT_ACCEPTED");
    expect(res.body).not.toContain("28.6139");
  });

  it("GET /sos/:incidentId shows exact location to an ACCEPTED responder", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "accepted-1" }),
    });
    const incidentId = created.json().incident.id;

    await app.inject({ method: "GET", url: "/device/me", headers: OTHER });
    await db.insertIncidentResponderIfAbsent({
      incidentId,
      deviceId: VALID_DEVICE_ID_2,
      distanceAtNotifyM: 800,
      notifiedAt: new Date().toISOString(),
    });
    await db.updateIncidentResponder(incidentId, VALID_DEVICE_ID_2, {
      status: "ACCEPTED",
      accepted_at: new Date().toISOString(),
    });

    const res = await app.inject({ method: "GET", url: `/sos/${incidentId}`, headers: OTHER });

    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.viewer.role).toBe("RESPONDER");
    expect(view.viewer.responderStatus).toBe("ACCEPTED");
    expect(view.location.latitude).toBeCloseTo(28.6139);
    // A responder never sees evidence or call detail.
    expect(view.evidence).toEqual([]);
    expect(view.calls).toEqual([]);
    expect(view.responders).toHaveLength(1);
    expect(view.responders[0].deviceId).toBe(VALID_DEVICE_ID_2);
  });

  it("GET /sos/:incidentId returns 404 for unknown or malformed IDs", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/sos/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      headers: OWNER,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("INCIDENT_NOT_FOUND");

    const malformed = await app.inject({
      method: "GET",
      url: "/sos/not-a-uuid",
      headers: OWNER,
    });
    expect(malformed.statusCode).toBe(404);
  });

  it("POST /sos/:id/cancel cancels from ACTIVE and records the reason", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "cancel-1" }),
    });
    const incidentId = created.json().incident.id;

    const res = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: { reason: "Pocket dial" },
    });

    expect(res.statusCode).toBe(200);
    const incident = res.json().incident;
    expect(incident.status).toBe("CANCELLED");
    expect(incident.cancelReason).toBe("Pocket dial");
    expect(incident.cancelledAt).toBeTruthy();

    const audit = db.getAuditLogs().filter((e) => e.event_type === "sos.cancelled");
    expect(audit.some((e) => e.incident_id === incidentId)).toBe(true);
  });

  it("POST /sos/:id/cancel rejects a non-owner device", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "cancel-forbidden-1" }),
    });
    const incidentId = created.json().incident.id;

    const res = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OTHER,
      payload: { reason: "not mine" },
    });

    expect(res.statusCode).toBe(403);
    const stored = await db.getIncident(incidentId);
    expect(stored?.status).toBe("ACTIVE");
  });

  it("POST /sos/:id/cancel validates the body and the state machine", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "cancel-states-1" }),
    });
    const incidentId = created.json().incident.id;

    const noReason = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: { reason: "false alarm" },
    });
    const twice = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: { reason: "again" },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("POST /sos/:id/resolve is rejected until a responder acknowledged", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "resolve-order-1" }),
    });
    const incidentId = created.json().incident.id;

    const tooEarly = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/resolve`,
      headers: OWNER,
      payload: { resolutionReason: "I am safe" },
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error.code).toBe("INVALID_STATE_TRANSITION");

    // Simulate the notification pipeline and a first acceptance.
    await db.updateIncident(incidentId, { status: "HELP_REQUESTED" });
    await db.updateIncident(incidentId, { status: "RESPONDER_ACKNOWLEDGED" });

    const res = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/resolve`,
      headers: OWNER,
      payload: { resolutionReason: "Help arrived" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().incident.status).toBe("RESOLVED");
    expect(res.json().incident.resolutionReason).toBe("Help arrived");
  });

  it("POST /sos/:id/resolve rejects a non-owner device", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: sosBody({ clientRequestId: "resolve-forbidden-1" }),
    });
    const incidentId = created.json().incident.id;
    await db.updateIncident(incidentId, { status: "HELP_REQUESTED" });
    await db.updateIncident(incidentId, { status: "RESPONDER_ACKNOWLEDGED" });

    const res = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/resolve`,
      headers: OTHER,
      payload: { resolutionReason: "not mine" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("enforces the per-device rate limit on SOS creation", async () => {
    const { app: limitedApp } = makeTestApp({ RATE_LIMIT_MAX: "2" });
    await limitedApp.ready();
    const headers = { "x-device-id": VALID_DEVICE_ID_3 };

    const first = await limitedApp.inject({
      method: "POST",
      url: "/sos",
      headers,
      payload: sosBody({ clientRequestId: "rate-1" }),
    });
    const second = await limitedApp.inject({
      method: "POST",
      url: "/sos",
      headers,
      payload: sosBody({ clientRequestId: "rate-2" }),
    });
    const third = await limitedApp.inject({
      method: "POST",
      url: "/sos",
      headers,
      payload: sosBody({ clientRequestId: "rate-3" }),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("RATE_LIMITED");
    expect(third.headers["retry-after"]).toBeDefined();

    await limitedApp.close();
  });
});
