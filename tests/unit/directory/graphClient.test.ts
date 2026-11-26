import { describe, expect, it, vi } from "vitest";
import { assertGraphUrl, GraphClient, GraphRequestError, parseRetryAfter } from "@/modules/directory/graph/graphClient";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(responses: Response[], extra: { maxRetries?: number } = {}) {
  const sleeps: number[] = [];
  const fetchImpl = vi.fn(async () => responses.shift() ?? json({}, 500));
  const c = new GraphClient({ getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async (ms) => { sleeps.push(ms); }, ...extra });
  return { c, fetchImpl, sleeps };
}

describe("GraphClient", () => {
  it("sends the bearer token and returns JSON", async () => {
    const { c, fetchImpl } = client([json({ ok: 1 })]);
    expect(await c.get("/users/x")).toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.microsoft.com/v1.0/users/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
  it("returns null on 404", async () => {
    expect(await client([json({}, 404)]).c.get("/users/x")).toBeNull();
  });
  it("retries a 429 after the Retry-After delay, then succeeds", async () => {
    const { c, fetchImpl, sleeps } = client([json({}, 429, { "retry-after": "7" }), json({ v: 1 })]);
    expect(await c.get("/users")).toEqual({ v: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([7000]);
  });
  it("backs off exponentially when there is no Retry-After, and caps the wait", async () => {
    const { c, sleeps } = client([json({}, 503), json({}, 503), json({ v: 1 })]);
    await c.get("/users");
    expect(sleeps).toEqual([1000, 2000]);
    const capped = client([json({}, 429, { "retry-after": "9999" }), json({ v: 1 })]);
    await capped.c.get("/users");
    expect(capped.sleeps).toEqual([60_000]);
  });
  it("gives up after maxRetries and surfaces the status", async () => {
    const { c, fetchImpl } = client([json({}, 429), json({}, 429), json({}, 429)], { maxRetries: 2 });
    await expect(c.get("/users")).rejects.toMatchObject({ name: "GraphRequestError", status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not retry other errors", async () => {
    const { c, fetchImpl } = client([json({}, 403)]);
    await expect(c.get("/users")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses non-Graph URLs, so a hostile nextLink cannot redirect the bearer token", async () => {
    const { c, fetchImpl } = client([json({})]);
    await expect(c.get("https://evil.example/steal")).rejects.toBeInstanceOf(GraphRequestError);
    await expect(c.get("http://graph.microsoft.com/v1.0/users")).rejects.toBeInstanceOf(GraphRequestError);
    expect(() => assertGraphUrl("https://graph.microsoft.com.evil.example/x")).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseRetryAfter", () => {
  it("handles seconds, HTTP dates and garbage", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("Wed, 01 Jan 2026 00:00:10 GMT", Date.parse("Wed, 01 Jan 2026 00:00:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
