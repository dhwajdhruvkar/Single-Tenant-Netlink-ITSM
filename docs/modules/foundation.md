# Foundation (Phase 1)

- `src/platform/config/env.ts` — zod-validated environment; `loadConfig()` is called at server start by
  `src/instrumentation.ts`. Invalid config prints every problem (never secret values) and exits non-zero in production.
  Production/staging additionally require `AUTH_SECRET`, `ENTRA_*`, `CRON_SECRET`, an https `APP_BASE_URL`. Any Postgres host
  is accepted (no vendor lock-in).
- `src/platform/errors.ts` + `src/platform/http/handler.ts` — `withApi()` wraps route handlers: request id
  (`x-request-id`), error mapping, JSON envelope `{data}` / `{error:{code,message,details}}`. Unknown errors return a generic 500.
- `src/platform/http/pagination.ts` — strict page/pageSize/sort parsing.
- `src/platform/logging/logger.ts` — JSON stdout with credential redaction (adapted from the reference implementation).
- `src/platform/clientIp.ts` — client address only trusted behind a declared proxy (`TRUST_PROXY_HEADERS=1`).
- `src/platform/rateLimit/dbRateLimit.ts` — interface only; fail-open until the DB table exists (P2) and the limiter is
  completed (P11).
- `src/platform/db/prisma.ts` — singleton client + `withTransaction`. `prisma/schema.prisma` is a generator/datasource
  placeholder until Phase 2.
- Lint: `src/modules/**` may not import `next/*`, `next-auth/*` or `@vercel/*`.
- `/api/health` (liveness) and `/api/ready` (`SELECT 1`; 503 when the DB is unreachable).
- `Dockerfile` — standalone, non-root. Uses the full `node:22-bookworm` base (OpenSSL included) so the build needs no apt step.

## Prisma and `DIRECT_URL`
The datasource declares `directUrl`. Verified with Prisma 6.19.3 inside the production image: the runtime client connects and
`/api/ready` returns 200 with `DIRECT_URL` **unset**, so the runtime does not need the migrator URL. `DIRECT_URL` is only needed
by migration commands.

## Prisma engine target
`binaryTargets` includes `debian-openssl-3.0.x`: the Docker build stage has no OpenSSL to auto-detect, which previously generated an
`openssl-1.1.x` engine that failed at runtime (found by running the container, not by typecheck).
