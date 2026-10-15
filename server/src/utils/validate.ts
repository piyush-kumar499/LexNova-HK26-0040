import type { ZodType } from "zod";
import { badRequest } from "./errors.js";

/**
 * Validates request data with a Zod schema and throws the consistent
 * AppError (400 VALIDATION_ERROR with field details) on failure.
 */
export function parseOrThrow<T>(
  schema: ZodType<T>,
  data: unknown,
  message = "Invalid request body",
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      "VALIDATION_ERROR",
      message,
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
