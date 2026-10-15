import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeTestApp,
  waitFor,
  VALID_DEVICE_ID,
  VALID_DEVICE_ID_2,
  type TestApp,
} from "./helpers/setup.js";

const OWNER = { "x-device-id": VALID_DEVICE_ID };
const OTHER = { "x-device-id": VALID_DEVICE_ID_2 };

function minutesAgoISO(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function queuedBody(options: { clientRequestId: string; activatedAt: string; triggerType?: string }) {
  return {
    triggerType: options.triggerType ?? "shake",
    latitude: 28.6139,
    longitude: 77.209,
    locationAccuracy: 25,
    deviceTimestamp: options.activatedAt,
    clientRequestId: options.clientRequestId,
  };
}

describe("Offline-queued SOS events", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps the original activation time when a queued event arrives late", async () => {
    const activatedAt = minutesAgoISO(35);
    const res = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: queuedBody({ clientRequestId: "offline-late-1", activatedAt }),
    });

    expect(res.statusCode).toBe(201);
    const incident = res.json().incident;
    // The activation happened on the device 35 minutes ago (§14)…
    expect(incident.activatedAt).toBe(activatedAt);
    // …and the server honestly records that it only heard about it now.
    expect(Date.parse(incident.createdAt) - Date.parse(activatedAt)).toBeGreaterThan(
      30 * 60_000,
    );

    const stored = await db.getIncident(incident.id);
    expect(stored?.device_timestamp).toBe(activatedAt);
    expect(stored?.activated_at).toBe(activatedAt);
  });

  it("accepts an offset timestamp and preserves the instant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: queuedBody({
        clientRequestId: "offline-offset-1",
        activatedAt: "2026-10-15T14:30:00+05:30",
      }),
    });

    expect(res.statusCode).toBe(201);
    expect(Date.parse(res.json().incident.activatedAt)).toBe(
      Date.parse("2026-10-15T09:00:00.000Z"),
    );
  });

  it("flushes a queue of events, each keeping its own activation time", async () => {
    const queue = [
      { clientRequestId: "offline-flush-1", activatedAt: minutesAgoISO(60), trigger: "shake" },
      { clientRequestId: "offline-flush-2", activatedAt: minutesAgoISO(40), trigger: "button" },
      { clientRequestId: "offline-flush-3", activatedAt: minutesAgoISO(20), trigger: "voice" },
    ];

    const ids: string[] = [];
    for (const item of queue) {
      const res = await app.inject({
        method: "POST",
        url: "/sos",
        headers: OWNER,
        payload: queuedBody({
          clientRequestId: item.clientRequestId,
          activatedAt: item.activatedAt,
          triggerType: item.trigger,
        }),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().incident.activatedAt).toBe(item.activatedAt);
      ids.push(res.json().incident.id);
    }

    expect(new Set(ids).size).toBe(3);
    for (const [index, id] of ids.entries()) {
      const stored = await db.getIncident(id);
      expect(stored?.activated_at).toBe(queue[index]?.activatedAt);
    }
  });

  it("re-delivering a queued event returns the same incident without re-escalating", async () => {
    await db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Queued Amma",
      phoneNumber: "+919000000800",
      priority: 1,
    });

    const payload = queuedBody({
      clientRequestId: "offline-replay-1",
      activatedAt: minutesAgoISO(10),
    });
    const first = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    expect(first.statusCode).toBe(201);
    const incidentId = first.json().incident.id;

    // The app crashed after sending but before persisting the response and
    // re-sends the queued item twice on the next launch.
    for (let i = 0; i < 2; i += 1) {
      const replay = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().created).toBe(false);
      expect(replay.json().incident.id).toBe(incidentId);
      // The activation time survives replays unchanged.
      expect(replay.json().incident.activatedAt).toBe(payload.deviceTimestamp);
    }

    const audits = db.getAuditLogs().filter((entry) => entry.incident_id === incidentId);
    expect(audits.filter((entry) => entry.event_type === "sos.created")).toHaveLength(1);
    expect(audits.filter((entry) => entry.event_type === "sos.duplicate_replayed")).toHaveLength(2);

    // The one real creation dispatched escalation exactly once.
    await waitFor(async () => (await db.listCallEvents(incidentId)).length === 1);
    expect(await db.listCallEvents(incidentId)).toHaveLength(1);
  });

  it("scopes the idempotency key to the device, not just the request id", async () => {
    const payload = queuedBody({
      clientRequestId: "offline-shared-1",
      activatedAt: minutesAgoISO(5),
    });
    const mine = await app.inject({ method: "POST", url: "/sos", headers: OWNER, payload });
    const theirs = await app.inject({ method: "POST", url: "/sos", headers: OTHER, payload });

    expect(mine.statusCode).toBe(201);
    expect(theirs.statusCode).toBe(201);
    expect(theirs.json().incident.id).not.toBe(mine.json().incident.id);
  });

  it("escalates a stale queued event like a live one", async () => {
    // A fresh app so the contact list starts empty — this device queues one
    // event, and it must be dialed even though the activation is hours old.
    const fresh = makeTestApp();
    await fresh.app.ready();
    await fresh.db.createTrustedContact({
      deviceId: VALID_DEVICE_ID,
      contactName: "Stale Amma",
      phoneNumber: "+919000000801",
      priority: 1,
    });

    const activatedAt = minutesAgoISO(120);
    const res = await fresh.app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: queuedBody({
        clientRequestId: "offline-stale-1",
        activatedAt,
      }),
    });
    expect(res.statusCode).toBe(201);
    const incidentId = res.json().incident.id;

    await waitFor(async () => (await fresh.db.listCallEvents(incidentId)).length === 1);
    const [call] = await fresh.db.listCallEvents(incidentId);
    expect(call?.recipient_reference).toBe("+919000000801");
    expect(call?.level).toBe(1);

    const stored = await fresh.db.getIncident(incidentId);
    expect(stored?.activated_at).toBe(activatedAt);

    await fresh.app.close();
  });

  it("rejects timestamps that are missing or lack a timezone", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: {
        triggerType: "shake",
        latitude: 28.6139,
        longitude: 77.209,
        clientRequestId: "offline-bad-1",
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("VALIDATION_ERROR");

    const noZone = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: queuedBody({ clientRequestId: "offline-bad-2", activatedAt: "2026-10-14T09:00:00" }),
    });
    expect(noZone.statusCode).toBe(400);
    expect(noZone.json().error.code).toBe("VALIDATION_ERROR");

    const garbage = await app.inject({
      method: "POST",
      url: "/sos",
      headers: OWNER,
      payload: queuedBody({ clientRequestId: "offline-bad-3", activatedAt: "yesterday" }),
    });
    expect(garbage.statusCode).toBe(400);
  });
});
