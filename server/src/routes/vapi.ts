import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { verifyVapiWebhookSignature } from "../services/vapi.service.js";
import { unauthorized } from "../utils/errors.js";

/**
 * POST /vapi/webhook (spec §5.10). Verifies the provider signature, then
 * acknowledges immediately: processing (call_events updates, evidence,
 * escalation) continues in the background so slow work never delays the ack.
 */
export function vapiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/vapi/webhook", async (request) => {
    const secret = ctx.config.vapi.webhookSecret;

    if (secret) {
      const rawBody = request.rawBody;
      const verified =
        rawBody !== undefined &&
        verifyVapiWebhookSignature(request.headers, rawBody, secret);
      if (!verified) {
        ctx.log.warn({ ip: request.ip }, "vapi webhook: signature verification failed");
        throw unauthorized(
          "INVALID_WEBHOOK_SIGNATURE",
          "Webhook signature verification failed",
        );
      }
    } else {
      ctx.log.warn(
        "vapi webhook: VAPI_WEBHOOK_SECRET is not configured — accepting unverified webhook (development only)",
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;

    void ctx.vapiWebhook.process(body).catch((error: unknown) => {
      ctx.log.error({ err: error }, "vapi webhook: background processing failed");
    });

    return { received: true };
  });
}
