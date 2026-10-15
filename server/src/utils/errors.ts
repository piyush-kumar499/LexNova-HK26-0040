/**
 * Typed application errors. The error middleware (middleware/error.ts) maps
 * AppError to the consistent API error shape:
 *   { error: { code, message, details? } }
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown): AppError =>
  new AppError(code, 400, message, details);

export const unauthorized = (code: string, message: string): AppError =>
  new AppError(code, 401, message);

export const forbidden = (code: string, message: string): AppError =>
  new AppError(code, 403, message);

export const notFound = (code: string, message: string): AppError =>
  new AppError(code, 404, message);

export const conflict = (code: string, message: string, details?: unknown): AppError =>
  new AppError(code, 409, message, details);

export const rateLimited = (message: string): AppError =>
  new AppError("RATE_LIMITED", 429, message);

/** Raised by database implementations. `code` carries the Postgres SQLSTATE when known. */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof DatabaseError && error.code === PG_UNIQUE_VIOLATION;
}
