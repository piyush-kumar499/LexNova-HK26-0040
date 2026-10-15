import type { AppConfig } from "../config/env.js";
import type { DeviceRow } from "../models/device.model.js";
import type { Database } from "../services/supabase.service.js";
import type { AppContext } from "../app.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    ctx: AppContext;
  }
  interface FastifyRequest {
    /** Set by the deviceAuth middleware on every device-authenticated route. */
    device?: DeviceRow;
  }
}
