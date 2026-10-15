import type { AppConfig } from "../config/env.js";
import type { Database } from "../services/supabase.service.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
  }
}
