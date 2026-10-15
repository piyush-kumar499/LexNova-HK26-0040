import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import { MemoryDatabase } from "../../src/services/memory.service.js";

export function makeTestConfig(
  overrides: Partial<Record<string, string>> = {},
): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    PORT: "0",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestApp {
  app: FastifyInstance;
  db: MemoryDatabase;
  config: AppConfig;
}

export function makeTestApp(
  overrides: Partial<Record<string, string>> = {},
): TestApp {
  const config = makeTestConfig(overrides);
  const db = new MemoryDatabase();
  const app = buildApp({ config, db });
  return { app, db, config };
}

export const VALID_DEVICE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
export const VALID_DEVICE_ID_2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const VALID_DEVICE_ID_3 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
