import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, DatabaseError } from "../utils/errors.js";

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function toBody(code: string, message: string, details?: unknown): ErrorBody {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return body;
}

/**
 * Consistent error shape for every failure:
 *   { error: { code, message, details? } }
 * Internal details never leak to clients; they are logged server-side.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | DatabaseError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.httpStatus).send(toBody(error.code, error.message, error.details));
    }

    // Fastify-level errors (body parse failures, content-type issues, schema).
    if ("validation" in error && (error as FastifyError).validation) {
      return reply
        .status(400)
        .send(toBody("VALIDATION_ERROR", (error as FastifyError).message));
    }
    const fastifyCode = "code" in error ? (error as FastifyError).code : undefined;
    if (typeof fastifyCode === "string" && fastifyCode.startsWith("FST_ERR_CTP")) {
      return reply
        .status((error as FastifyError).statusCode ?? 400)
        .send(toBody("INVALID_REQUEST_BODY", "Request body could not be parsed"));
    }

    if (error instanceof DatabaseError) {
      request.log.error({ err: error }, "database error");
      return reply
        .status(500)
        .send(toBody("DATABASE_ERROR", "A database error occurred. Nothing was changed."));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(toBody("INTERNAL_ERROR", "Internal server error"));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(404)
      .send(toBody("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });
}
