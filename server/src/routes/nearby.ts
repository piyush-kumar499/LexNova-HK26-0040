import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { DeviceRow } from "../models/device.model.js";
import { badRequest, forbidden } from "../utils/errors.js";
import { parseOrThrow } from "../utils/validate.js";

const nearbyQuerySchema = z
  .object({
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().min(50).max(50_000).optional(),
    maxResults: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
    error: "latitude and longitude must be provided together",
    path: ["longitude"],
  });

export function nearbyRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Polling endpoint for devices that opted in to respond. Returns active
   * incidents around the caller with an approximate distance — never victim
   * coordinates (spec §11). Polling records the caller as NOTIFIED for each
   * visible incident, which is what makes a later ACCEPT possible.
   *
   * Not behind the device rate limiter: frequent polling is the designed use,
   * and its only write is an idempotent insert-if-absent.
   */
  app.get("/nearby/sos", { preHandler: ctx.deviceAuth }, async (request) => {
    const device = request.device as DeviceRow;
    if (!device.can_respond) {
      throw forbidden("RESPONDER_DISABLED", "Responding is disabled for this device");
    }

    const query = parseOrThrow(
      nearbyQuerySchema,
      request.query,
      "Invalid query parameters",
    );

    let latitude = query.latitude;
    let longitude = query.longitude;
    let locationSource: "request" | "stored" = "request";
    if (latitude === undefined || longitude === undefined) {
      const stored = await ctx.db.getLatestDeviceLocation(device.device_id);
      if (!stored) {
        throw badRequest(
          "LOCATION_REQUIRED",
          "Provide latitude/longitude query parameters or report a location first",
        );
      }
      latitude = stored.latitude;
      longitude = stored.longitude;
      locationSource = "stored";
    }

    const incidents = await ctx.nearbyService.listNearbyIncidents({
      deviceId: device.device_id,
      latitude,
      longitude,
      radiusMeters: query.radiusMeters ?? ctx.config.nearby.radiusMeters,
      maxResults: query.maxResults ?? ctx.config.nearby.maxResults,
    });

    return { incidents, locationSource };
  });
}
