import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { DeviceRow, TrustedContactRow } from "../models/device.model.js";
import { createContactSchema } from "../models/device.model.js";
import { isUuid } from "../utils/crypto.js";
import { notFound } from "../utils/errors.js";
import { parseOrThrow } from "../utils/validate.js";

function toContactView(row: TrustedContactRow): Record<string, unknown> {
  return {
    id: row.id,
    contactName: row.contact_name,
    phoneNumber: row.phone_number,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function contactsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/contacts",
    { preHandler: ctx.deviceAuth },
    async (request) => {
      const device = request.device as DeviceRow;
      const contacts = await ctx.deviceService.listContacts(device.device_id);
      return { contacts: contacts.map(toContactView) };
    },
  );

  app.post(
    "/contacts",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request, reply) => {
      const device = request.device as DeviceRow;
      const input = parseOrThrow(createContactSchema, request.body);
      const contact = await ctx.deviceService.createContact(device.device_id, input);

      await ctx.db.appendAuditLog({
        deviceId: device.device_id,
        incidentId: null,
        eventType: "contact.created",
        data: { contactId: contact.id, priority: contact.priority },
      });

      reply.code(201);
      return { contact: toContactView(contact) };
    },
  );

  app.delete(
    "/contacts/:contactId",
    { preHandler: [ctx.deviceAuth, ctx.deviceRateLimit] },
    async (request, reply) => {
      const device = request.device as DeviceRow;
      const { contactId } = request.params as { contactId: string };
      // Malformed IDs are treated as unknown contacts, not DB errors.
      if (!isUuid(contactId)) throw notFound("CONTACT_NOT_FOUND", "Contact not found");

      await ctx.deviceService.deleteContact(device.device_id, contactId);

      await ctx.db.appendAuditLog({
        deviceId: device.device_id,
        incidentId: null,
        eventType: "contact.deleted",
        data: { contactId },
      });

      reply.code(204);
      return null;
    },
  );
}
