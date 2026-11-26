import { Prisma, type PrismaClient } from "@prisma/client";
import { RateLimitedError } from "@/platform/errors";

// Postgres-backed fixed-window rate limiter: correct across multiple app instances (unlike an in-process Map).
// One atomic upsert per check; the window restarts when it has expired.

export interface RateLimitRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(rule: RateLimitRule): Promise<RateLimitResult>;
}

export function dbRateLimiter(db: Pick<PrismaClient, "$queryRaw">): RateLimiter {
  return {
    async check({ key, limit, windowSeconds }) {
      const rows = await db.$queryRaw<{ count: number; secondsLeft: number }[]>(Prisma.sql`
        INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
        VALUES (${key}, 1, now() + make_interval(secs => ${windowSeconds}))
        ON CONFLICT ("key") DO UPDATE SET
          "count"   = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
          "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN now() + make_interval(secs => ${windowSeconds}) ELSE "RateLimitBucket"."resetAt" END
        RETURNING "count", CEIL(EXTRACT(EPOCH FROM ("resetAt" - now())))::int AS "secondsLeft"`);
      const { count, secondsLeft } = rows[0];
      const allowed = count <= limit;
      return { allowed, remaining: Math.max(0, limit - count), ...(allowed ? {} : { retryAfterSeconds: Math.max(1, secondsLeft) }) };
    },
  };
}

/** Throws RateLimitedError (429 + Retry-After) when the rule is exceeded. */
export async function enforceRateLimit(limiter: RateLimiter, rule: RateLimitRule): Promise<void> {
  const r = await limiter.check(rule);
  if (!r.allowed) throw new RateLimitedError("Too many requests. Please slow down.", r.retryAfterSeconds);
}
