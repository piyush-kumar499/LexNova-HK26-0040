import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * UUID v4 — the device identity format (spec §4). Case-insensitive input;
 * callers normalize to lowercase before storage/lookup.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceUuid(value: string): boolean {
  return UUID_V4_RE.test(value);
}

export function normalizeDeviceId(value: string): string {
  return value.trim().toLowerCase();
}

/** Any UUID shape (used for route params like :incidentId before DB lookup). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * HMAC-SHA256 over the raw body, hex-encoded. Used for Vapi webhook
 * signature verification (spec §5.10).
 */
export function hmacSha256Hex(secret: string, rawBody: Buffer | string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time string comparison (signature checks must not leak timing). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
