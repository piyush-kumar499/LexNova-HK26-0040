import { loadConfig, type AppConfig } from "../../src/config/env.js";

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
