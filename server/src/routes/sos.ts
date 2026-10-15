import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { DeviceRow } from "../models/device.model.js";
import {
  cancelSosSchema,
  createSosSchema,
  resolveSosSchema,
  respondSosSchema,
} from "../models/sos.model.js";
import { toIncidentCore, toResponderView } from "../services/sos.service.js";
import { isUuid } from "../utils/crypto.js";
import { notFound } from "../utils/errors.js";
import { parseOrThrow } from "../utils/validate.js";

function incidentIdParam(params: unknown): string {
  const { incidentId } = params as { incidentId: string };
  // Malformed IDs are treated as unknown incidents, not DB errors.
  if (!isUuid(incidentId)) throw notFound("INCIDENT_NOT_FOUND", "Incident not found");
  return incidentId;
}

export function sosRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/sos",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request, reply) => {
      const device = request.device as DeviceRow;
      const input = parseOrThrow(createSosSchema, request.body);

      const { incident, created } = await ctx.sosService.create(device.device_id, input);

      // 201 on first creation, 200 when an idempotent replay returns the
      // existing incident (offline queue replays land here, spec §14).
      reply.code(created ? 201 : 200);
      return { incident: toIncidentCore(incident), created };
    },
  );

  app.get(
    "/sos/:incidentId",
    { preHandler: ctx.deviceAuth },
    async (request) => {
      const device = request.device as DeviceRow;
      const incidentId = incidentIdParam(request.params);
      return ctx.sosService.getIncidentForDevice(device.device_id, incidentId);
    },
  );

  app.post(
    "/sos/:incidentId/cancel",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request) => {
      const device = request.device as DeviceRow;
      const incidentId = incidentIdParam(request.params);
      const input = parseOrThrow(cancelSosSchema, request.body);
      const incident = await ctx.sosService.cancel(device.device_id, incidentId, input);
      return { incident: toIncidentCore(incident) };
    },
  );

  app.post(
    "/sos/:incidentId/resolve",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request) => {
      const device = request.device as DeviceRow;
      const incidentId = incidentIdParam(request.params);
      const input = parseOrThrow(resolveSosSchema, request.body);
      const incident = await ctx.sosService.resolve(device.device_id, incidentId, input);
      return { incident: toIncidentCore(incident) };
    },
  );

  app.post(
    "/sos/:incidentId/respond",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request) => {
      const device = request.device as DeviceRow;
      const incidentId = incidentIdParam(request.params);
      const input = parseOrThrow(respondSosSchema, request.body);
      const { incident, responder } = await ctx.sosService.respond(
        device.device_id,
        incidentId,
        input.action,
      );
      return { incident: toIncidentCore(incident), responder: toResponderView(responder) };
    },
  );
}
