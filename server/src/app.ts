import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type preHandlerHookHandler } from "fastify";
import type { AppConfig } from "./config/env.js";
import { buildLoggerOptions } from "./utils/logger.js";
import { createDatabase, type Database } from "./services/supabase.service.js";
import { DeviceService } from "./services/device.service.js";
import { createDeviceAuth, createDeviceRateLimit } from "./middleware/deviceAuth.js";
import { createRateLimiter, type RateLimiter } from "./middleware/rateLimit.js";
import { registerErrorHandlers } from "./middleware/error.js";
import { healthRoutes } from "./routes/health.js";
import { deviceRoutes } from "./routes/device.js";

/**
 * Shared context handed to route registrars. Grows as features land
 * (services, providers) while keeping construction in one place.
 */
export interface AppContext {
  config: AppConfig;
  db: Database;
  log: FastifyBaseLogger;
  deviceService: DeviceService;
  limiter: RateLimiter;
  /** Identity middleware: validates X-Device-Id, auto-registers, attaches request.device. */
  deviceAuth: preHandlerHookHandler;
  /** Chain after deviceAuth on every mutating endpoint. */
  deviceRateLimit: preHandlerHookHandler;
}

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

  const limiter = createRateLimiter(deps.config);
  const deviceService = new DeviceService(bundle.db);
  const deviceAuth = createDeviceAuth({ deviceService });

  const ctx: AppContext = {
    config: deps.config,
    db: bundle.db,
    log: app.log,
    deviceService,
    limiter,
    deviceAuth,
    deviceRateLimit: createDeviceRateLimit(limiter),
  };

  app.decorate("config", deps.config);
  app.decorate("db", bundle.db);
  app.decorate("ctx", ctx);
  app.log.info({ databaseMode: bundle.mode }, "database ready");

  registerErrorHandlers(app);

  app.register(healthRoutes);
  deviceRoutes(app, ctx);

  return app;
}
