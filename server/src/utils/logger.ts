import type { AppConfig } from "../config/env.js";

/**
 * Fastify-managed pino options (not an instance): Fastify creates the logger
 * and exposes it as `app.log`, keeping instance types on their defaults.
 */
export function buildLoggerOptions(
  config: Pick<AppConfig, "logLevel" | "nodeEnv">,
): {
  level: string;
  redact: { paths: string[]; censor: string };
  transport?: { target: string; options: Record<string, unknown> };
} {
  const usePretty = config.nodeEnv === "development";
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-vapi-signature']",
        "*.privateKey",
        "*.serviceRoleKey",
        "*.webhookSecret",
      ],
      censor: "[REDACTED]",
    },
    ...(usePretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        }
      : {}),
  };
}
