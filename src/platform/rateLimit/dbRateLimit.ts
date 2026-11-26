// Rate limiting contract. The Postgres-backed implementation needs the RateLimitBucket table (Phase 2) and is
// completed in Phase 11. Until then every request is allowed (fail-open), so callers can already depend on the
// interface. This is intentionally NOT an in-process limiter: those are unsafe with multiple instances.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface RateLimitRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimiter {
  check(rule: RateLimitRule): Promise<RateLimitResult>;
}

export const unlimitedRateLimiter: RateLimiter = {
  async check(rule) {
    return { allowed: true, remaining: rule.limit };
  },
};
