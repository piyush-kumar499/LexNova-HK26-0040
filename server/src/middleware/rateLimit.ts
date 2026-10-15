import type { AppConfig } from "../config/env.js";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

/**
 * In-memory sliding-window limiter. Keyed by device ID for authenticated
 * routes. Single-process only (acceptable for this deployment model; a
 * multi-instance deployment would need a shared store — documented in README).
 */
export function createRateLimiter(config: AppConfig): RateLimiter {
  const { windowMs, max } = config.rateLimit;
  const hits = new Map<string, number[]>();

  return {
    check(key: string): RateLimitDecision {
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (timestamps.length >= max) {
        const oldest = timestamps[0] ?? now;
        hits.set(key, timestamps);
        return { allowed: false, retryAfterMs: Math.max(oldest + windowMs - now, 0) };
      }

      timestamps.push(now);
      hits.set(key, timestamps);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
