import type { FastifyInstance } from "fastify";

export function healthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    return { status: "ok", time: new Date().toISOString() };
  });
}
