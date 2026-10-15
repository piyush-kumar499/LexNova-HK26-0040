import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { makeTestConfig } from "./helpers/setup.js";

describe("GET /health", () => {
  const config = makeTestConfig();
  const app = buildApp({ config });

  afterAll(async () => {
    await app.close();
  });

  it("returns status ok and an ISO timestamp without device auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; time: string };
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });
});
