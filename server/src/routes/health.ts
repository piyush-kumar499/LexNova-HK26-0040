import type { FastifyInstance } from "fastify";

export function healthRoutes(app: FastifyInstance): void {
  app.get("/", async () => {
    return {
      service: "lexnova-ss01-server",
      status: "ok",
      health: "/health",
    };
  });

  app.get("/health", async () => {
    return { status: "ok", time: new Date().toISOString() };
  });
}
