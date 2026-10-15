import type { CreateContactInput, DeviceRow, TrustedContactRow } from "../models/device.model.js";
import type { Database } from "./supabase.service.js";
import { badRequest, conflict, isUniqueViolation, notFound } from "../utils/errors.js";

const LAST_SEEN_THROTTLE_MS = 60_000;

/** Strips separators; requires 7-15 digits with optional leading +. */
export function normalizePhoneNumber(input: string): string {
  const stripped = input.replace(/[ ()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(stripped)) {
    throw badRequest(
      "VALIDATION_ERROR",
      "phoneNumber must contain 7-15 digits, optionally starting with +",
      [{ path: "phoneNumber", message: "invalid phone number" }],
    );
  }
  return stripped;
}

export class DeviceService {
  constructor(private readonly db: Database) {}

  /**
   * Device "registration" (spec §4.2): first sight of a valid device ID
   * creates the device row with defaults. Race-safe: a concurrent first
   * request losing the insert race re-reads the winner's row.
   */
  async getOrRegister(deviceId: string): Promise<DeviceRow> {
    const existing = await this.db.getDeviceByDeviceId(deviceId);
    if (existing) return existing;
    try {
      const created = await this.db.createDevice(deviceId);
      await this.db.appendAuditLog({
        deviceId,
        incidentId: null,
        eventType: "device.registered",
        data: { note: "auto-registered on first request; no signup" },
      });
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const row = await this.db.getDeviceByDeviceId(deviceId);
        if (row) return row;
      }
      throw error;
    }
  }

  /** Updates last_seen_at at most once per minute per device. */
  async maybeTouchLastSeen(device: DeviceRow): Promise<void> {
    const last = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
    if (Date.now() - last < LAST_SEEN_THROTTLE_MS) return;
    await this.db.updateDevice(device.device_id, { last_seen_at: new Date().toISOString() });
  }

  /**
   * Applies a profile patch. null or "" clears displayName/phoneNumber;
   * phoneNumber is normalized to +digits before storage.
   */
  async updateProfile(
    deviceId: string,
    patch: { displayName?: string | null; phoneNumber?: string | null; canRespond?: boolean },
  ): Promise<DeviceRow | null> {
    const dbPatch: Partial<
      Pick<DeviceRow, "display_name" | "phone_number" | "can_respond">
    > = {};

    if (patch.displayName !== undefined) {
      dbPatch.display_name =
        patch.displayName === null || patch.displayName === "" ? null : patch.displayName;
    }
    if (patch.phoneNumber !== undefined) {
      dbPatch.phone_number =
        patch.phoneNumber === null || patch.phoneNumber === ""
          ? null
          : normalizePhoneNumber(patch.phoneNumber);
    }
    if (patch.canRespond !== undefined) {
      dbPatch.can_respond = patch.canRespond;
    }

    return this.db.updateDevice(deviceId, dbPatch);
  }

  /** Trusted contacts, in the order they will be called (priority asc). */
  async listContacts(deviceId: string): Promise<TrustedContactRow[]> {
    return this.db.listTrustedContacts(deviceId);
  }

  /**
   * Adds a trusted contact. Phone numbers are normalized to +digits so the
   * same human cannot be dialed twice via different formats (spec §7).
   */
  async createContact(deviceId: string, input: CreateContactInput): Promise<TrustedContactRow> {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    try {
      return await this.db.createTrustedContact({
        deviceId,
        contactName: input.contactName,
        phoneNumber,
        priority: input.priority ?? 10,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "CONTACT_EXISTS",
          "This phone number is already one of your trusted contacts",
        );
      }
      throw error;
    }
  }

  async deleteContact(deviceId: string, contactId: string): Promise<void> {
    const deleted = await this.db.deleteTrustedContact(deviceId, contactId);
    if (!deleted) throw notFound("CONTACT_NOT_FOUND", "Contact not found");
  }
}
