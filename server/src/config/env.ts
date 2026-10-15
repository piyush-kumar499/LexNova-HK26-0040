import { z } from "zod";

export type NodeEnv = "development" | "test" | "production";
export type MockVapiOutcome = "answered" | "no-answer" | "silent";

export interface AppConfig {
  port: number;
  nodeEnv: NodeEnv;
  logLevel: string;
  supabase: {
    url: string | null;
    serviceRoleKey: string | null;
    anonKey: string | null;
  };
  vapi: {
    privateKey: string | null;
    publicKey: string | null;
    phoneNumberId: string | null;
    assistantId: string | null;
    webhookSecret: string | null;
    apiBaseUrl: string;
  };
  ngrokUrl: string | null;
  rateLimit: { windowMs: number; max: number };
  nearby: { radiusMeters: number; maxResults: number };
  escalation: { timeoutSeconds: number; maxLevel: number };
  mockVapiOutcome: MockVapiOutcome;
}

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  PORT: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(65535).default(8080),
  ),
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  ),
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_PHONE_NUMBER_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_ASSISTANT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  VAPI_API_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.url().default("https://api.vapi.ai"),
  ),
  NGROK_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  RATE_LIMIT_WINDOW_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(60_000),
  ),
  RATE_LIMIT_MAX: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(30),
  ),
  NEARBY_RADIUS_METERS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().default(2000),
  ),
  NEARBY_MAX_RESULTS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(50),
  ),
  SOS_ESCALATION_TIMEOUT_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().positive().default(60),
  ),
  SOS_MAX_ESCALATION_LEVEL: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(3),
  ),
  MOCK_VAPI_OUTCOME: z.preprocess(
    emptyToUndefined,
    z.enum(["answered", "no-answer", "silent"]).default("answered"),
  ),
});

/**
 * Parses and validates configuration from an environment source.
 * Pure function (no dotenv side effect) so tests can pass explicit values.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        "Invalid environment configuration — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production (the in-memory database is development-only).",
      );
    }
    if (env.VAPI_PRIVATE_KEY && !env.VAPI_WEBHOOK_SECRET) {
      throw new Error(
        "Invalid environment configuration — VAPI_WEBHOOK_SECRET is required in production when real Vapi calling is enabled (webhooks must be verifiable).",
      );
    }
  }

  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    supabase: {
      url: env.SUPABASE_URL ?? null,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
      anonKey: env.SUPABASE_ANON_KEY ?? null,
    },
    vapi: {
      privateKey: env.VAPI_PRIVATE_KEY ?? null,
      publicKey: env.VAPI_PUBLIC_KEY ?? null,
      phoneNumberId: env.VAPI_PHONE_NUMBER_ID ?? null,
      assistantId: env.VAPI_ASSISTANT_ID ?? null,
      webhookSecret: env.VAPI_WEBHOOK_SECRET ?? null,
      apiBaseUrl: env.VAPI_API_BASE_URL,
    },
    ngrokUrl: env.NGROK_URL ?? null,
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    nearby: {
      radiusMeters: env.NEARBY_RADIUS_METERS,
      maxResults: env.NEARBY_MAX_RESULTS,
    },
    escalation: {
      timeoutSeconds: env.SOS_ESCALATION_TIMEOUT_SECONDS,
      maxLevel: env.SOS_MAX_ESCALATION_LEVEL,
    },
    mockVapiOutcome: env.MOCK_VAPI_OUTCOME,
  };
}

export function isSupabaseConfigured(config: AppConfig): boolean {
  return Boolean(config.supabase.url && config.supabase.serviceRoleKey);
}

const VAPI_REQUIRED_VARS = [
  "VAPI_PRIVATE_KEY",
  "VAPI_PHONE_NUMBER_ID",
  "VAPI_ASSISTANT_ID",
] as const;

/** Names of Vapi env vars that are missing; empty array = fully configured. */
export function missingVapiVars(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.vapi.privateKey) missing.push(VAPI_REQUIRED_VARS[0]);
  if (!config.vapi.phoneNumberId) missing.push(VAPI_REQUIRED_VARS[1]);
  if (!config.vapi.assistantId) missing.push(VAPI_REQUIRED_VARS[2]);
  return missing;
}

/** True only when a real outbound call can be placed (never faked). */
export function isVapiFullyConfigured(config: AppConfig): boolean {
  return missingVapiVars(config).length === 0;
}
