import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeTestApp,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  VALID_DEVICE_ID_3,
  type TestApp,
} from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const POLLER = { "x-device-id": VALID_DEVICE_ID_2 };
const DISABLED = { "x-device-id": VALID_DEVICE_ID_3 };
const FRESH = { "x-device-id": "9c858901-8a57-4791-81fe-4c455b099bc9" };

/** Delhi reference point; 1 degree of latitude ≈ 111.2 km. */
const BASE = { latitude: 28.6139, longitude: 77.209 };
const LAT_PER_METER = 1 / 111_194.93;

async function waitForDispatch(db: TestApp["db"], incidentId: string): Promise<void> {
  await waitFor(async () => (await db.getIncident(incidentId))?.status === "HELP_REQUESTED");
}

async function createIncident(
  app: TestApp["app"],
  headers: Record<string, string>,
  lat = BASE.latitude,
  lng = BASE.longitude,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sos",
    headers,
    payload: {
      triggerType: "button",
      latitude: lat,
      longitude: lng,
      locationAccuracy: 10,
      deviceTimestamp: new Date().toISOString(),
      clientRequestId: `nearby-${Math.random().toString(36).slice(2, 12)}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().incident.id as string;
}

function poll(
  app: TestApp["app"],
  headers: Record<string, string>,
  query: Record<string, number> = {},
) {
  const qs = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  ).toString();
  return app.inject({
    method: "GET",
    url: qs ? `/nearby/sos?${qs}` : "/nearby/sos",
    headers,
  });
}

describe("GET /nearby/sos", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
    // A device that opted out of responding.
    db.seedDevice(VALID_DEVICE_ID_3, { can_respond: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists a nearby active incident with an approximate distance and no coordinates", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    // Poll from ~222 m north of the incident.
    const res = await poll(app, POLLER, {
      latitude: BASE.latitude + 222 * LAT_PER_METER,
      longitude: BASE.longitude,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locationSource).toBe("request");
    expect(body.incidents).toHaveLength(1);

    const item = body.incidents[0];
    expect(item.incidentId).toBe(incidentId);
    expect(item.status).toBe("HELP_REQUESTED");
    expect(item.triggerType).toBe("button");
    expect(item.approximateDistanceM).toBe(200);
    expect(item.responderStatus).toBe("NOTIFIED");
    expect(typeof item.activatedAt).toBe("string");

    // Pre-accept privacy (spec §11): the payload never carries coordinates.
    expect(JSON.stringify(body)).not.toMatch(/"(latitude|longitude)"/);
  });

  it("never reports a distance below the 100 m rounding floor", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    // Poll from ~50 m away — still reported as 100 m, not near-exact.
    const res = await poll(app, POLLER, {
      latitude: BASE.latitude + 50 * LAT_PER_METER,
      longitude: BASE.longitude,
    });

    expect(res.statusCode).toBe(200);
    const item = res.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId);
    expect(item.approximateDistanceM).toBe(100);
  });

  it("registers the polling device as NOTIFIED exactly once", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    const query = {
      latitude: BASE.latitude + 222 * LAT_PER_METER,
      longitude: BASE.longitude,
    };
    const first = await poll(app, POLLER, query);
    expect(first.statusCode).toBe(200);

    const responder = await db.getIncidentResponder(incidentId, VALID_DEVICE_ID_2);
    expect(responder).not.toBeNull();
    expect(responder?.status).toBe("NOTIFIED");
    expect(responder?.distance_at_notify_m).toBeGreaterThan(200);
    expect(responder?.distance_at_notify_m).toBeLessThan(250);

    const second = await poll(app, POLLER, query);
    expect(second.statusCode).toBe(200);
    expect(
      second.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId)
        .responderStatus,
    ).toBe("NOTIFIED");

    // No duplicate membership, no moved timestamp.
    const memberships = (await db.listIncidentResponders(incidentId)).filter(
      (row) => row.device_id === VALID_DEVICE_ID_2,
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.notified_at).toBe(responder?.notified_at);

    const events = db
      .getResponderEvents()
      .filter(
        (event) =>
          event.incident_id === incidentId &&
          event.device_id === VALID_DEVICE_ID_2 &&
          event.event_type === "responder.nearby_notified",
      );
    expect(events).toHaveLength(1);

    const audits = db
      .getAuditLogs()
      .filter((entry) => entry.incident_id === incidentId && entry.event_type === "nearby.responder_notified");
    expect(audits).toHaveLength(1);
  });

  it("falls back to the stored device location when query params are missing", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    db.seedDeviceLocation(VALID_DEVICE_ID_2, BASE.latitude + 222 * LAT_PER_METER, BASE.longitude, 1_000);

    const stored = await poll(app, POLLER);
    expect(stored.statusCode).toBe(200);
    expect(stored.json().locationSource).toBe("stored");
    expect(
      stored.json().incidents.some((i: { incidentId: string }) => i.incidentId === incidentId),
    ).toBe(true);
  });

  it("keeps devices and incidents outside the radius apart", async () => {
    const incidentId = await createIncident(app, OWNER);
    await waitForDispatch(db, incidentId);

    // ~1.1 km away, polling with a 500 m radius.
    const res = await poll(app, POLLER, {
      latitude: BASE.latitude + 1_112 * LAT_PER_METER,
      longitude: BASE.longitude,
      radiusMeters: 500,
    });

    expect(res.statusCode).toBe(200);
    expect(
      res.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId),
    ).toBeUndefined();
    expect(await db.getIncidentResponder(incidentId, VALID_DEVICE_ID_2)).toBeNull();
  });

  it("sorts by distance and respects maxResults", async () => {
    const farId = await createIncident(app, OWNER);
    const nearId = await createIncident(app, OWNER, BASE.latitude + 111 * LAT_PER_METER);
    await waitForDispatch(db, farId);
    await waitForDispatch(db, nearId);

    // Poll from 222 m north: near incident is ~111 m, far incident ~222 m.
    const query = {
      latitude: BASE.latitude + 222 * LAT_PER_METER,
      longitude: BASE.longitude,
      radiusMeters: 1000,
    };

    const all = await poll(app, POLLER, query);
    const ordered = all
      .json()
      .incidents.map((i: { incidentId: string }) => i.incidentId)
      .filter((id: string) => id === nearId || id === farId);
    expect(ordered).toEqual([nearId, farId]);

    const limited = await poll(app, POLLER, { ...query, maxResults: 1 });
    const only = limited
      .json()
      .incidents.map((i: { incidentId: string }) => i.incidentId)
      .filter((id: string) => id === nearId || id === farId);
    expect(only).toEqual([nearId]);
  });

  it("never shows callers their own incident", async () => {
    const incidentId = await createIncident(app, OWNER, BASE.latitude + 500 * LAT_PER_METER);
    await waitForDispatch(db, incidentId);

    const res = await poll(app, OWNER, {
      latitude: BASE.latitude + 500 * LAT_PER_METER,
      longitude: BASE.longitude,
    });

    expect(res.statusCode).toBe(200);
    expect(
      res.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId),
    ).toBeUndefined();
  });

  it("hides cancelled incidents from nearby devices", async () => {
    const incidentId = await createIncident(app, OWNER, BASE.latitude + 700 * LAT_PER_METER);
    await waitForDispatch(db, incidentId);

    const cancelled = await app.inject({
      method: "POST",
      url: `/sos/${incidentId}/cancel`,
      headers: OWNER,
      payload: { reason: "false alarm" },
    });
    expect(cancelled.statusCode).toBe(200);

    const res = await poll(app, POLLER, {
      latitude: BASE.latitude + 700 * LAT_PER_METER,
      longitude: BASE.longitude,
    });
    expect(
      res.json().incidents.find((i: { incidentId: string }) => i.incidentId === incidentId),
    ).toBeUndefined();
  });

  it("rejects devices that opted out of responding", async () => {
    const res = await poll(app, DISABLED, {
      latitude: BASE.latitude,
      longitude: BASE.longitude,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("RESPONDER_DISABLED");
  });

  it("requires a location when neither query params nor a stored fix exist", async () => {
    const missing = await poll(app, FRESH);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("LOCATION_REQUIRED");

    const both = await poll(app, FRESH, { latitude: 28.6 });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe("VALIDATION_ERROR");

    const unknown = await poll(app, FRESH, {
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      foo: 1,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("VALIDATION_ERROR");
  });
});
