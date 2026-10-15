import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

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
}

main().catch((error: unknown) => {
  console.error("SS-01 server failed to start:", error);
  process.exit(1);
});
