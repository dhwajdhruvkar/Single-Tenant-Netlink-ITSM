import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withApi, ok, readJson } from "@/platform/http/handler";
import {
  ConflictError, ForbiddenError, NotFoundError, RateLimitedError, UnauthenticatedError, ValidationError,
} from "@/platform/errors";

const req = (init?: RequestInit & { url?: string }) => new Request(init?.url ?? "http://localhost/api/x", init);

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("withApi error mapping", () => {
  const cases: Array<[string, Error, number, string]> = [
    ["validation", new ValidationError("bad"), 400, "validation_error"],
    ["unauthenticated", new UnauthenticatedError(), 401, "unauthenticated"],
    ["forbidden", new ForbiddenError(), 403, "forbidden"],
    ["not found", new NotFoundError(), 404, "not_found"],
    ["conflict", new ConflictError(), 409, "conflict"],
    ["rate limited", new RateLimitedError("slow", 30), 429, "rate_limited"],
  ];
  for (const [name, err, status, code] of cases) {
    it(`maps ${name} to ${status}`, async () => {
      const res = await withApi(() => { throw err; })(req());
      expect(res.status).toBe(status);
      expect(((await body(res)).error as { code: string }).code).toBe(code);
    });
  }

  it("sets Retry-After on 429", async () => {
    const res = await withApi(() => { throw new RateLimitedError("slow", 30); })(req());
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("maps ZodError to 400 with issues", async () => {
    const res = await withApi(() => { z.object({ a: z.string() }).parse({}); return ok(1); })(req());
    expect(res.status).toBe(400);
    const e = (await body(res)).error as { details: { issues: unknown[] } };
    expect(e.details.issues.length).toBeGreaterThan(0);
  });

  it("hides unknown error details behind a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withApi(() => { throw new Error("db password is hunter2"); })(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await body(res))).not.toContain("hunter2");
    spy.mockRestore();
  });

  it("wraps success in { data } and echoes a request id", async () => {
    const res = await withApi(() => ok({ a: 1 }))(req({ headers: { "x-request-id": "abcdefgh-123" } }));
    expect(await body(res)).toEqual({ data: { a: 1 } });
    expect(res.headers.get("x-request-id")).toBe("abcdefgh-123");
  });

  it("replaces a malformed request id", async () => {
    const res = await withApi(() => ok(1))(req({ headers: { "x-request-id": "bad id!" } }));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes route params", async () => {
    const res = await withApi((_r, ctx) => ok(ctx.params))(req(), { params: Promise.resolve({ ref: "INC-1" }) });
    expect(await body(res)).toEqual({ data: { ref: "INC-1" } });
  });
});

describe("readJson", () => {
  it("rejects invalid JSON with 400", async () => {
    await expect(readJson(req({ method: "POST", body: "{nope" }))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects oversized bodies with 413", async () => {
    await expect(readJson(req({ method: "POST", body: "x".repeat(1024 * 1024 + 1) }))).rejects.toMatchObject({ status: 413 });
  });
});
