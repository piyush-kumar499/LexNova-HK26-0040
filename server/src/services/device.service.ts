import type { DeviceRow } from "../models/device.model.js";
import type { Database } from "./supabase.service.js";
import { isUniqueViolation } from "../utils/errors.js";

const LAST_SEEN_THROTTLE_MS = 60_000;

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
      return await this.db.createDevice(deviceId);
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

  async updateProfile(
    deviceId: string,
    patch: { displayName?: string | null; phoneNumber?: string | null; canRespond?: boolean },
  ): Promise<DeviceRow | null> {
    const dbPatch: Partial<
      Pick<DeviceRow, "display_name" | "phone_number" | "can_respond">
    > = {};
    if (patch.displayName !== undefined) dbPatch.display_name = patch.displayName;
    if (patch.phoneNumber !== undefined) dbPatch.phone_number = patch.phoneNumber;
    if (patch.canRespond !== undefined) dbPatch.can_respond = patch.canRespond;
    return this.db.updateDevice(deviceId, dbPatch);
  }
}
