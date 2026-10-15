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
