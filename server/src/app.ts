import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyError,
  type FastifyBaseLogger,
  type FastifyInstance,
  type preHandlerHookHandler,
} from "fastify";
import type { AppConfig } from "./config/env.js";
import { buildLoggerOptions } from "./utils/logger.js";
import { createDatabase, type Database } from "./services/supabase.service.js";
import { DeviceService } from "./services/device.service.js";
import { SosService } from "./services/sos.service.js";
import { EscalationService } from "./services/escalation.service.js";
import { NearbyService } from "./services/nearby.service.js";
import {
  createCallProvider,
  VapiWebhookService,
  type CallProviderClient,
} from "./services/vapi.service.js";
import { createDeviceAuth, createDeviceRateLimit } from "./middleware/deviceAuth.js";
import { createRateLimiter, type RateLimiter } from "./middleware/rateLimit.js";
import { registerErrorHandlers } from "./middleware/error.js";
import { healthRoutes } from "./routes/health.js";
import { deviceRoutes } from "./routes/device.js";
import { sosRoutes } from "./routes/sos.js";
import { vapiRoutes } from "./routes/vapi.js";
import { nearbyRoutes } from "./routes/nearby.js";

/**
 * Shared context handed to route registrars. Grows as features land
 * (services, providers) while keeping construction in one place.
 */
export interface AppContext {
  config: AppConfig;
  db: Database;
  log: FastifyBaseLogger;
  deviceService: DeviceService;
  sosService: SosService;
  escalation: EscalationService;
  nearbyService: NearbyService;
  callProvider: CallProviderClient;
  vapiWebhook: VapiWebhookService;
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

  // Keep the raw JSON body so webhook signatures can be verified byte-for-byte
  // (spec §5.10); parsing is otherwise identical to the Fastify default.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw.toString("utf8")));
      } catch {
        const error = new Error("Invalid JSON body") as FastifyError;
        error.code = "FST_ERR_CTP_INVALID_JSON_BODY";
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  const bundle = deps.db
    ? { db: deps.db, mode: "injected" as const }
    : createDatabase(deps.config, app.log);

  const limiter = createRateLimiter(deps.config);
  const deviceService = new DeviceService(bundle.db);
  const deviceAuth = createDeviceAuth({ deviceService });
  const callProvider = createCallProvider(deps.config, app.log);
  const nearbyService = new NearbyService(bundle.db, app.log);
  const escalation = new EscalationService(
    bundle.db,
    callProvider,
    app.log,
    deps.config,
    nearbyService,
  );
  const sosService = new SosService(bundle.db, app.log, escalation);
  const vapiWebhook = new VapiWebhookService(bundle.db, escalation, app.log);

  const ctx: AppContext = {
    config: deps.config,
    db: bundle.db,
    log: app.log,
    deviceService,
    sosService,
    escalation,
    nearbyService,
    callProvider,
    vapiWebhook,
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
  sosRoutes(app, ctx);
  vapiRoutes(app, ctx);
  nearbyRoutes(app, ctx);

  app.addHook("onClose", async () => {
    escalation.stop();
  });

  // Resume incidents left open by a previous process (spec §10). Only for the
  // real backend: an injected database is a test double the caller owns.
  if (!deps.db) {
    void escalation.rehydrateOpenIncidents().catch((error: unknown) => {
      app.log.error({ err: error }, "escalation: boot rehydration failed");
    });
  }

  return app;
}
