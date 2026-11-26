import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, RateLimitedError } from "@/platform/errors";
import { assertSameOrigin } from "@/platform/http/csrf";
import { logger } from "@/platform/logging/logger";

// JSON envelope: success -> { data }, failure -> { error: { code, message, details? } }.

export interface ApiContext {
  requestId: string;
  params: Record<string, string | string[]>;
}

type RouteContext = { params?: Promise<Record<string, string | string[]>> };

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json({ data }, { status: 201 });
}

function requestIdFrom(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
}

export function errorResponse(err: unknown, requestId: string): NextResponse {
  let appErr: AppError | undefined;
  if (err instanceof AppError) appErr = err;
  else if (err instanceof ZodError) {
    appErr = new AppError(400, "validation_error", "The request is invalid.", {
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  if (!appErr) {
    logger.error("unhandled error", { requestId, error: err });
    const res = NextResponse.json(
      { error: { code: "internal_error", message: "Something went wrong." } },
      { status: 500 },
    );
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const res = NextResponse.json(
    { error: { code: appErr.code, message: appErr.message, ...(appErr.details !== undefined ? { details: appErr.details } : {}) } },
    { status: appErr.status },
  );
  if (appErr instanceof RateLimitedError && appErr.retryAfterSeconds) {
    res.headers.set("Retry-After", String(appErr.retryAfterSeconds));
  }
  res.headers.set("x-request-id", requestId);
  return res;
}

/** Wrap a route handler: request id, error mapping, response envelope. */
export function withApi(
  handler: (req: Request, ctx: ApiContext) => Promise<Response> | Response,
  options: { csrf?: boolean } = {},
) {
  return async (req: Request, routeCtx?: RouteContext): Promise<Response> => {
    const requestId = requestIdFrom(req);
    try {
      // Cookie-authenticated mutations are origin-checked. Bearer-secret endpoints (cron) opt out with { csrf: false }.
      if (options.csrf !== false) assertSameOrigin(req, process.env.APP_BASE_URL ?? "http://localhost:3000");
      const params = (await routeCtx?.params) ?? {};
      const res = await handler(req, { requestId, params });
      if (!res.headers.has("x-request-id")) res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** Read a JSON body with a size limit, throwing ValidationError on bad input. */
export const MAX_JSON_BYTES = 1024 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) {
    throw new AppError(413, "payload_too_large", "Request body too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "validation_error", "Request body must be valid JSON.");
  }
}
