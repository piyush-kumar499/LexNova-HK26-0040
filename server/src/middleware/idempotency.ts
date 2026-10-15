import { isUniqueViolation } from "../utils/errors.js";

export interface FindOrCreateResult<T> {
  value: T;
  created: boolean;
}

/**
 * Race-safe idempotent create (spec §11). The caller supplies the lookup,
 * the insert, and a re-read for the case where a concurrent request wins the
 * unique constraint — the loser then returns the winner's record instead of
 * erroring or duplicating. SOS creation keys this on
 * (device_id, client_request_id); offline replays (spec §14) hit the same path.
 */
export async function findOrCreate<T>(options: {
  find: () => Promise<T | null>;
  create: () => Promise<T>;
  readAfterConflict: () => Promise<T | null>;
}): Promise<FindOrCreateResult<T>> {
  const existing = await options.find();
  if (existing !== null) return { value: existing, created: false };

  try {
    const created = await options.create();
    return { value: created, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await options.readAfterConflict();
    if (winner === null) throw error;
    return { value: winner, created: false };
  }
}
