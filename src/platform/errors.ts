// Application error types. Route handlers map these to HTTP via withApi().

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request is invalid.", details?: unknown) {
    super(400, "validation_error", message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication is required.") {
    super(401, "unauthenticated", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do this.") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with the current state.", details?: unknown) {
    super(409, "conflict", message, details);
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds?: number;

  constructor(message = "Too many requests.", retryAfterSeconds?: number) {
    super(429, "rate_limited", message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request is well-formed but cannot be processed in the current state (e.g. requester not eligible). */
export class UnprocessableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}
