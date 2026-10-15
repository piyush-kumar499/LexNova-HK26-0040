import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp, VALID_DEVICE_ID, VALID_DEVICE_ID_2 } from "./helpers/setup.js";

const UUID_V1 = "6f9619ff-8b86-1d01-b42d-00cf4fc964ff"; // version nibble = 1, invalid for us

describe("deviceAuth middleware", () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof makeTestApp>["db"];

  beforeAll(async () => {
    const testApp = makeTestApp({ RATE_LIMIT_MAX: "3" });
    app = testApp.app;
    db = testApp.db;

    app.get(
      "/probe",
      { preHandler: app.ctx.deviceAuth },
      async (request) => ({ deviceId: request.device?.device_id ?? null }),
    );
    app.post(
      "/probe-mutate",
      { preHandler: [app.ctx.deviceAuth, app.ctx.deviceRateLimit] },
      async () => ({ ok: true }),
    );
    await app.ready();
  });

  it("rejects a missing X-Device-Id with the consistent error shape", async () => {
    const res = await app.inject({ method: "GET", url: "/probe" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MISSING_DEVICE_ID");
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects malformed device IDs (non-v4, garbage, empty)", async () => {
    for (const bad of [UUID_V1, "hello-world", "6f9619ff8b864d01b42d00cf4fc964ff"]) {
      const res = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { "x-device-id": bad },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("INVALID_DEVICE_ID");
    }

    // whitespace-only is semantically missing
    const blank = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-device-id": "   " },
    });
    expect(blank.statusCode).toBe(400);
    expect((blank.json() as { error: { code: string } }).error.code).toBe("MISSING_DEVICE_ID");
  });

  it("auto-registers a new device on first request (no signup)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-device-id": VALID_DEVICE_ID },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deviceId: string }).deviceId).toBe(VALID_DEVICE_ID);

    const device = await db.getDeviceByDeviceId(VALID_DEVICE_ID);
    expect(device).not.toBeNull();
    expect(device?.can_respond).toBe(true);
    expect(device?.is_active).toBe(true);
  });

  it("does not create a duplicate row on subsequent requests", async () => {
    const before = await db.getDeviceByDeviceId(VALID_DEVICE_ID);
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-device-id": VALID_DEVICE_ID },
    });
    const after = await db.getDeviceByDeviceId(VALID_DEVICE_ID);
    expect(res.statusCode).toBe(200);
    expect(after?.id).toBe(before?.id);
    expect(after?.created_at).toBe(before?.created_at);
  });

  it("accepts uppercase UUIDs and normalizes to lowercase", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-device-id": VALID_DEVICE_ID_2.toUpperCase() },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deviceId: string }).deviceId).toBe(VALID_DEVICE_ID_2);
    expect(await db.getDeviceByDeviceId(VALID_DEVICE_ID_2)).not.toBeNull();
  });

  it("rejects deactivated devices", async () => {
    const deactivated = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    db.seedDevice(deactivated, { is_active: false });
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { "x-device-id": deactivated },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("DEVICE_INACTIVE");
  });

  it("rate-limits mutating requests per device", async () => {
    const device = "11111111-2222-4333-8444-555555555555";
    const hit = () =>
      app.inject({ method: "POST", url: "/probe-mutate", headers: { "x-device-id": device } });

    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(200);

    const fourth = await hit();
    expect(fourth.statusCode).toBe(429);
    expect((fourth.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(fourth.headers["retry-after"]).toBeDefined();

    // a different device is unaffected
    const other = await app.inject({
      method: "POST",
      url: "/probe-mutate",
      headers: { "x-device-id": VALID_DEVICE_ID_2 },
    });
    expect(other.statusCode).toBe(200);
  });

  it("does not rate-limit GET routes (polling fallback must work)", async () => {
    const device = "99999999-8888-4777-8666-555555555555";
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { "x-device-id": device },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
