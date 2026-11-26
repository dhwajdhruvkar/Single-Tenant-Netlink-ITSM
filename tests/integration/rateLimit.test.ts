import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RateLimitedError } from "@/platform/errors";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
const limiter = dbRateLimiter(prisma);

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

describe("dbRateLimiter", () => {
  it("allows up to the limit then blocks with a Retry-After", async () => {
    const rule = { key: "k", limit: 30, windowSeconds: 60 };
    for (let i = 1; i <= 30; i++) expect((await limiter.check(rule)).allowed).toBe(true);
    const blocked = await limiter.check(rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("keys are independent", async () => {
    await limiter.check({ key: "a", limit: 1, windowSeconds: 60 });
    expect((await limiter.check({ key: "a", limit: 1, windowSeconds: 60 })).allowed).toBe(false);
    expect((await limiter.check({ key: "b", limit: 1, windowSeconds: 60 })).allowed).toBe(true);
  });

  it("starts a new window once the old one has expired", async () => {
    const rule = { key: "w", limit: 1, windowSeconds: 60 };
    await limiter.check(rule);
    expect((await limiter.check(rule)).allowed).toBe(false);
    await prisma.$executeRawUnsafe(`UPDATE "RateLimitBucket" SET "resetAt" = now() - interval '1 second' WHERE key = 'w'`);
    expect((await limiter.check(rule)).allowed).toBe(true);
  });

  it("is atomic: 100 concurrent checks admit exactly `limit` requests", async () => {
    const rule = { key: "race", limit: 30, windowSeconds: 60 };
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check(rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
  });

  it("enforceRateLimit throws RateLimitedError with the retry time", async () => {
    const rule = { key: "e", limit: 1, windowSeconds: 60 };
    await enforceRateLimit(limiter, rule);
    await expect(enforceRateLimit(limiter, rule)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(enforceRateLimit(limiter, rule)).rejects.toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
  });
});
