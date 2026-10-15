import { z } from "zod";

/**
 * devices table row. There is intentionally NO "role" column — a device can
 * both request help and respond, and its role is derived per incident.
 */
export interface DeviceRow {
  id: string;
  device_id: string;
  display_name: string | null;
  phone_number: string | null;
  is_active: boolean;
  can_respond: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

/** Latest-only location per device (device_locations table, one row per device). */
export interface DeviceLocation {
  device_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  captured_at: string;
}

export interface TrustedContactRow {
  id: string;
  device_id: string;
  contact_name: string;
  phone_number: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const phoneNumberSchema = z
  .string()
  .trim()
  .min(7)
  .max(24)
  .regex(
    /^[+0-9 ()-]+$/,
    "phoneNumber may contain digits, spaces, dashes, parentheses and an optional leading +",
  );

/** PATCH /device/me — null or "" clears a field. */
export const updateDeviceProfileSchema = z
  .object({
    displayName: z.string().trim().max(80).nullable().optional(),
    phoneNumber: z.union([phoneNumberSchema, z.literal(""), z.null()]).optional(),
    canRespond: z.boolean().optional(),
  })
  .strict();

export type UpdateDeviceProfileInput = z.infer<typeof updateDeviceProfileSchema>;

/** POST /device/location */
export const updateLocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000).nullable().optional(),
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
