import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, VALID_DEVICE_ID, type TestApp } from "./helpers/setup.js";

describe("device profile and location endpoints", () => {
  let app: TestApp["app"];
  let db: TestApp["db"];

  beforeAll(async () => {
    ({ app, db } = makeTestApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /device/me auto-registers an unknown device with defaults", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.device.deviceId).toBe(VALID_DEVICE_ID);
    expect(body.device.displayName).toBeNull();
    expect(body.device.phoneNumber).toBeNull();
    expect(body.device.canRespond).toBe(true);
    expect(body.device.isActive).toBe(true);
    expect(body.device.createdAt).toBeTruthy();

    // No role field exists anywhere on the device (spec §4.4).
    expect(body.device).not.toHaveProperty("role");
    expect(body.device).not.toHaveProperty("isHelper");

    // Registration is recorded in the audit log.
    const registered = db
      .getAuditLogs()
      .filter((entry) => entry.event_type === "device.registered");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.device_id).toBe(VALID_DEVICE_ID);
  });

  it("GET /device/me rejects a missing device ID", async () => {
    const res = await app.inject({ method: "GET", url: "/device/me" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_DEVICE_ID");
  });

  it("PATCH /device/me updates profile, normalizes the phone number, and GET reflects it", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: {
        displayName: "Aarav",
        phoneNumber: "+91 98765-43210",
        canRespond: false,
      },
    });

    expect(patch.statusCode).toBe(200);
    const updated = patch.json().device;
    expect(updated.displayName).toBe("Aarav");
    expect(updated.phoneNumber).toBe("+919876543210");
    expect(updated.canRespond).toBe(false);

    const get = await app.inject({
      method: "GET",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
    });
    expect(get.statusCode).toBe(200);
    const fetched = get.json().device;
    expect(fetched.displayName).toBe("Aarav");
    expect(fetched.phoneNumber).toBe("+919876543210");
    expect(fetched.canRespond).toBe(false);

    const audited = db
      .getAuditLogs()
      .filter((entry) => entry.event_type === "device.profile_updated");
    expect(audited.length).toBeGreaterThanOrEqual(1);
  });

  it("PATCH /device/me clears fields with null or empty string", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { displayName: null, phoneNumber: "" },
    });

    expect(res.statusCode).toBe(200);
    const device = res.json().device;
    expect(device.displayName).toBeNull();
    expect(device.phoneNumber).toBeNull();
  });

  it("PATCH /device/me rejects an empty patch", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH /device/me rejects an unparseable phone number", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { phoneNumber: "not-a-phone" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("PATCH /device/me rejects unknown fields (strict schema)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/device/me",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { role: "HELPER" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /device/location stores the latest location", async () => {
    const capturedAt = new Date().toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/device/location",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: {
        latitude: 28.6139,
        longitude: 77.209,
        accuracy: 12.5,
        capturedAt,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", capturedAt });

    const stored = await db.getLatestDeviceLocation(VALID_DEVICE_ID);
    expect(stored).not.toBeNull();
    expect(stored?.latitude).toBeCloseTo(28.6139);
    expect(stored?.longitude).toBeCloseTo(77.209);
    expect(stored?.accuracy).toBeCloseTo(12.5);
    expect(stored?.captured_at).toBe(capturedAt);
  });

  it("POST /device/location keeps only the latest fix per device", async () => {
    const first = new Date(Date.now() - 60_000).toISOString();
    const second = new Date().toISOString();

    await app.inject({
      method: "POST",
      url: "/device/location",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { latitude: 19.076, longitude: 72.8777, capturedAt: first },
    });
    await app.inject({
      method: "POST",
      url: "/device/location",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { latitude: 28.7041, longitude: 77.1025, capturedAt: second },
    });

    const stored = await db.getLatestDeviceLocation(VALID_DEVICE_ID);
    expect(stored?.latitude).toBeCloseTo(28.7041);
    expect(stored?.captured_at).toBe(second);
  });

  it("POST /device/location rejects out-of-range coordinates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/device/location",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: {
        latitude: 999,
        longitude: 77.209,
        capturedAt: new Date().toISOString(),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /device/location rejects a non-ISO capturedAt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/device/location",
      headers: { "x-device-id": VALID_DEVICE_ID },
      payload: { latitude: 28.6139, longitude: 77.209, capturedAt: "yesterday" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
