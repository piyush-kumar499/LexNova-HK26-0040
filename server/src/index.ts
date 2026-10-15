import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

  const probe = await app.db.ping();
  if (probe.ok) {
    app.log.info("database probe ok");
  } else {
    app.log.error(
      { error: probe.error },
      "database probe FAILED — if Supabase is configured, apply the SQL migrations " +
        "in server/migrations/ (see server/README.md). Endpoints touching the database will fail until then.",
    );
  }

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(
      { port: config.port, nodeEnv: config.nodeEnv },
      "SS-01 server listening",
    );
  } catch (error) {
    app.log.fatal({ err: error }, "SS-01 server failed to start");
    process.exit(1);
  }

  // Render sends SIGTERM on every deploy/restart; close cleanly so in-flight
  // requests finish and the escalation timer stops (app onClose hook).
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutdown signal received — closing server");
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, "error during shutdown");
          process.exit(1);
        },
      );
    });
  }
}

main().catch((error: unknown) => {
  console.error("SS-01 server failed to start:", error);
  process.exit(1);
});
