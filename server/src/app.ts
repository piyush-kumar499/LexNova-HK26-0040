import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/env.js";
import { buildLoggerOptions } from "./utils/logger.js";
import { createDatabase, type Database } from "./services/supabase.service.js";
import { healthRoutes } from "./routes/health.js";

export interface AppDeps {
  config: AppConfig;
  /** Tests inject a MemoryDatabase; production/dev resolve from config. */
  db?: Database;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(deps.config),
    trustProxy: true,
    genReqId: () => randomUUID(),
  });

  const bundle = deps.db
    ? { db: deps.db, mode: "injected" as const }
    : createDatabase(deps.config, app.log);

  app.decorate("config", deps.config);
  app.decorate("db", bundle.db);
  app.log.info({ databaseMode: bundle.mode }, "database ready");

  app.register(healthRoutes);

  return app;
}
