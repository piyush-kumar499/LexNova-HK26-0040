import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { DeviceService } from "../services/device.service.js";
import { badRequest, forbidden, rateLimited } from "../utils/errors.js";
import { isValidDeviceUuid, normalizeDeviceId } from "../utils/crypto.js";
import type { RateLimiter } from "./rateLimit.js";

export interface DeviceAuthDeps {
  deviceService: DeviceService;
}

/**
 * Device-based identity (spec §4): extracts X-Device-Id, validates UUID v4,
 * auto-registers unknown devices, attaches the device row to the request.
 * No login, no signup — the UUID is the identity. Never trusts any other
 * identity claim from the client.
 */
export function createDeviceAuth(deps: DeviceAuthDeps): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers["x-device-id"];
    if (typeof header !== "string" || header.trim() === "") {
      throw badRequest(
        "MISSING_DEVICE_ID",
        "X-Device-Id header is required (the device UUID generated on first app launch)",
      );
    }

    const deviceId = normalizeDeviceId(header);
    if (!isValidDeviceUuid(deviceId)) {
      throw badRequest("INVALID_DEVICE_ID", "X-Device-Id must be a UUID v4");
    }

    const device = await deps.deviceService.getOrRegister(deviceId);
    if (!device.is_active) {
      throw forbidden("DEVICE_INACTIVE", "This device has been deactivated");
    }

    request.device = device;
    await deps.deviceService.maybeTouchLastSeen(device);
  };
}

/**
 * Per-device rate limiting for mutating endpoints. Must be chained AFTER
 * deviceAuth (it keys on request.device). GET polling routes are exempt —
 * the /nearby/sos fallback is designed to be polled.
 */
export function createDeviceRateLimit(limiter: RateLimiter): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const deviceId = request.device?.device_id;
    if (!deviceId) return; // deviceAuth runs first; nothing to key on
    const decision = limiter.check(deviceId);
    if (!decision.allowed) {
      void reply.header("retry-after", Math.ceil(decision.retryAfterMs / 1000));
      throw rateLimited("Too many requests for this device — slow down and retry");
    }
  };
}
