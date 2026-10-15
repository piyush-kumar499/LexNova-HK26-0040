import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/env.js";
import { buildLoggerOptions } from "./utils/logger.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  config: AppConfig;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(deps.config),
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  app.decorate("config", deps.config);

  app.register(healthRoutes);

  return app;
}
