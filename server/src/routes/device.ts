import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { DeviceRow } from "../models/device.model.js";
import {
  updateDeviceProfileSchema,
  updateLocationSchema,
} from "../models/device.model.js";
import { badRequest, notFound } from "../utils/errors.js";
import { parseOrThrow } from "../utils/validate.js";

function toProfile(row: DeviceRow): Record<string, unknown> {
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    phoneNumber: row.phone_number,
    canRespond: row.can_respond,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function deviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/device/me",
    { preHandler: ctx.deviceAuth },
    async (request) => {
      // deviceAuth guarantees request.device
      return { device: toProfile(request.device as DeviceRow) };
    },
  );

  app.patch(
    "/device/me",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request) => {
      const device = request.device as DeviceRow;
      const patch = parseOrThrow(updateDeviceProfileSchema, request.body);
      if (Object.keys(patch).length === 0) {
        throw badRequest(
          "VALIDATION_ERROR",
          "Provide at least one of: displayName, phoneNumber, canRespond",
        );
      }

      const updated = await ctx.deviceService.updateProfile(device.device_id, patch);
      if (!updated) throw notFound("DEVICE_NOT_FOUND", "Device no longer exists");

      await ctx.db.appendAuditLog({
        deviceId: device.device_id,
        incidentId: null,
        eventType: "device.profile_updated",
        data: { fields: Object.keys(patch) },
      });

      return { device: toProfile(updated) };
    },
  );

  app.post(
    "/device/location",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request) => {
      const device = request.device as DeviceRow;
      const body = parseOrThrow(updateLocationSchema, request.body);

      await ctx.db.upsertDeviceLocation({
        device_id: device.device_id,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy ?? null,
        captured_at: body.capturedAt,
      });

      return { status: "ok", capturedAt: body.capturedAt };
    },
  );
}
