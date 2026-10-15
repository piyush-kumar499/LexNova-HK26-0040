import { describe, expect, it } from "vitest";
import {
  isSupabaseConfigured,
  isVapiFullyConfigured,
  loadConfig,
  missingVapiVars,
} from "../src/config/env.js";

describe("loadConfig", () => {
  it("applies defaults for a bare environment", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe("development");
    expect(config.rateLimit).toEqual({ windowMs: 60_000, max: 30 });
    expect(config.nearby).toEqual({ radiusMeters: 2000, maxResults: 50 });
    expect(config.escalation).toEqual({ timeoutSeconds: 60, maxLevel: 3 });
    expect(isSupabaseConfigured(config)).toBe(false);
    expect(missingVapiVars(config)).toEqual([
      "VAPI_PRIVATE_KEY",
      "VAPI_PHONE_NUMBER_ID",
      "VAPI_ASSISTANT_ID",
    ]);
  });

  it("rejects invalid numeric values", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("requires Supabase credentials in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/SUPABASE_URL/);
  });

  it("requires the webhook secret in production when Vapi calling is enabled", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "key",
        VAPI_PRIVATE_KEY: "vk",
      }),
    ).toThrow(/VAPI_WEBHOOK_SECRET/);
  });

  it("detects fully configured Vapi from all three required vars", () => {
    const config = loadConfig({
      VAPI_PRIVATE_KEY: "vk",
      VAPI_PHONE_NUMBER_ID: "pn",
      VAPI_ASSISTANT_ID: "as",
    });
    expect(isVapiFullyConfigured(config)).toBe(true);
    expect(missingVapiVars(config)).toEqual([]);
  });

  it("treats empty and whitespace-only strings as unset", () => {
    const config = loadConfig({ SUPABASE_URL: "", VAPI_PRIVATE_KEY: "   " });
    expect(config.supabase.url).toBeNull();
    expect(config.vapi.privateKey).toBeNull();
  });
});
