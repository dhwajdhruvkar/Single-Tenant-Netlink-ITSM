# Document G — TESTING_STRATEGY.md
Status: PLANNING ARTIFACT. No tests have been run for the new application (it does not exist yet).

## 1. Principles

- Tests run against **real Postgres** (Docker locally, a service container in CI). There is no in-memory store.
- Integration tests refuse to run unless the DB host is `localhost`, `127.0.0.1` or `postgres` and the DB name ends in `_test`. They never touch Neon.
- Every bug fix gets a regression test.
- Report real results only. A green build is not production readiness.

## 2. Layers and tooling

| Layer | Tool | Location | Runs in |
|---|---|---|---|
| Unit (pure logic) | Vitest | `tests/unit/**` | Every push |
| Integration (services + DB, route handlers invoked directly) | Vitest + Postgres | `tests/integration/**` | Every push (CI service container) |
| Component | Vitest + @testing-library/react + jsdom | `tests/component/**` | Every push |
| E2E browser | Playwright | `tests/e2e/**` | PR to main (against `next start` + Docker PG) and nightly against staging |
| Entra live | Manual checklist + optional Playwright with real test accounts | `docs/testing/entra-checklist.md` | Staging, before each release |
| Security | Vitest suites + OWASP ZAP baseline (staging) + gitleaks + `npm audit` | `tests/security/**` | Every push / weekly |
| Migration | Prisma migrate deploy on an empty DB + drift diff + upgrade from previous release dump | CI | Every push / release |
| Load | k6 | `tests/load/*.js` | Phase 11, before go-live, after major changes |

**E2E authentication without demo sign-in:** a Playwright fixture mints an Auth.js session cookie with `encode()` from `next-auth/jwt` and the test `AUTH_SECRET`, for seeded `UserAccount`s in the test DB. There is no test-only provider or code path in the app. The real Entra flow is verified separately (§5).

## 3. Key suites

### 3.1 Ticket creation (both forms, shared service) — Phase 5
1. Self-service: requester = creator = actor. Snapshots equal the Employee row.
2. Self-service body containing `requesterEmployeeId`, `requesterEmail`, `requesterName` or `createdBy` → 400 (strict schema). A DB check confirms no ticket was created.
3. Self-service ignores the role in the body or header. A role claim in the payload is rejected.
4. Assisted by an agent: requester = selected employee, creator = agent, channel recorded.
5. Assisted by `employee` role → 403. By `submitter` → 201 (only if the role is enabled).
6. Assisted with an unknown, disabled, guest or directory-deleted employee → 422.
7. Assisted payload with spoofed snapshot fields (`requesterDepartment`) → 400. Snapshots always come from the DB.
8. Priority: the impact×urgency matrix for all 9 combinations. An override without a reason → 400. An override by an employee → 400/403.
9. Routing: category default group, falls back to the triage group. An explicit group by an employee is rejected. An assignee not in the group → 422.
10. SLA dues computed with the calendar (24×7 and business hours across a weekend/holiday).
11. Idempotency: same key and body → same ticket (200, replay header). Same key with a different body → 409. Different users with the same key → two tickets.
12. Concurrency: 50 parallel creates → 50 unique numbers and references.
13. Atomicity: an injected failure in the audit insert → no ticket, event or job rows.
14. Events/audit/jobs: exactly one `created` event, one audit row, and the expected job rows with dedupe keys.
15. Attachments (Phase 6): linking someone else's staged attachment → 422. An already-linked attachment → 422. More than 10 → 400.
16. Validation limits: subject 3–200, description ≤ 20,000, unicode, whitespace-only rejected.
17. Rate limits: the 11th self-service create within a minute → 429.

### 3.2 Identity / auth — Phase 3
- `tid` mismatch denied; missing or malformed `oid` denied.
- Same `oid` with a changed UPN/mail maps to the same Employee.
- Two employees sharing a mail value do not collide.
- Role mapping: highest wins, unknown values ignored, roles removed in Entra are removed at next sign-in, manual grants preserved.
- Disabled account → 401 on the next request. `sessionVersion` bump → 401.
- Expired JWT → 401. Tampered JWT → 401.
- Unauthenticated page → redirect to `/signin`. Unauthenticated API → JSON 401.

### 3.3 Access control matrix — Phase 7/11
For roles {employee, submitter, agent (group member), agent (non-member), manager, admin} × relationships {own as requester, created by me, assigned to me, in my group, unassigned/triage, other group}, assert list visibility, detail 200/404, internal-note visibility, attachment download, and allowed transitions. Generate the expectations from Doc C §3.2 as a table.

### 3.4 Lifecycle — Phase 7
Exhaustive state-transition table (allowed and forbidden). SLA pause/resume minutes. Reopen window. Optimistic concurrency (409). Auto-close job.

### 3.5 Directory — Phase 4
Mapping with missing fields. Eligibility filter. Delta sync updates/disables. Graph 429 with `Retry-After`. Fallback threshold. Token cache dedupe.

### 3.6 Attachments — Phase 6
- Allowlist and blocked extensions; magic-byte mismatch; size cap; filename sanitisation (path traversal, control characters, RTL override).
- Download headers.
- 404 for unauthorised access and for internal attachments to employees.
- Staged cleanup.
- Provider contract suite (database, local; S3/Azure via MinIO/Azurite in an optional CI job).
- Persistence across app restart (integration: write, new Prisma client, read).

### 3.7 Jobs and notifications — Phase 8/9
- Two concurrent runners → each job processed once.
- Backoff and dead-letter.
- Schedule slot lease.
- Cron auth.
- Recipient matrix.
- Internal notes never notified to the requester.
- Template HTML escaping.
- A noop provider does not break flows.

## 4. Security tests (Phase 11)

- **Route inventory:** every API route must be guarded (static scan + runtime call without a session → 401).
- **IDOR:** iterate ticket/attachment/notification IDs belonging to others → 404.
- **Mass assignment:** strict zod schemas on every mutating endpoint (unknown keys → 400).
- **CSRF:** mutating requests with a foreign `Origin` → 403.
- **XSS:** message bodies rendered as text/markdown sanitised; stored payload `<img onerror>` is inert in the UI (Playwright).
- **Headers:** CSP, HSTS, X-Frame-Options/frame-ancestors, nosniff, Referrer-Policy.
- **CSV injection** in exports.
- **Rate limiting** works across two app instances sharing one DB (integration with two server processes).
- **Secrets:** gitleaks in CI; the env check refuses short secrets.
- **Dependencies:** `npm audit --omit=dev` with no high/critical.
- **ZAP baseline** scan against staging (authenticated session cookie).

## 5. Microsoft Entra manual checklist (staging, real test accounts — one per role)

1. An employee with no special role signs in → lands on "My tickets". `/desk` → 403 page.
2. An agent, a manager and an admin each see their navigation. Their API calls are permitted only per the matrix.
3. A user not assigned to the enterprise app (assignment required) → Entra blocks the sign-in.
4. A guest user from another tenant → denied (AADSTS or app `tid` check).
5. Remove a role in Entra → after re-sign-in the role is gone.
6. Disable the user in Entra → new sign-in blocked; after the sync job, the existing session gets 401.
7. MFA / Conditional Access prompts appear as per company policy (observed, not implemented by the app).
8. Sign-out clears the session. The back button does not reveal data (`Cache-Control: no-store` on authenticated pages).
9. Form B shows correct directory data for the signed-in user. Form A search finds a newly added Entra user (Graph fallback).
10. Mailbox scope: a test attempt to send as a non-support mailbox through the daemon app fails.

## 6. Migration tests

- CI: `prisma migrate deploy` on an empty `_test` DB, then `prisma migrate diff --exit-code` (drift) passes.
- Release upgrade test: restore the previous release's anonymised staging dump → `migrate deploy` → smoke tests.
- Destructive-change lint: a CI script fails a PR if a migration contains `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` or `ALTER … TYPE` without a `-- reviewed-destructive: <issue>` marker.
- Startup guard test: the app refuses a database containing the original schema markers.

## 7. Load tests (k6)

Assumptions [ASSUMPTION; confirm peaks with IT]:
- 2,000 employees, about 150 concurrent active users at peak.
- 40 agents.
- About 200 tickets/day, with peak bursts of 30/min (outage).

| Scenario | Load | Target |
|---|---|---|
| Agent queue list + filters | 40 VUs, 5 s think | p95 < 400 ms, 0 errors |
| Ticket detail + poll | 150 VUs, 15 s poll | p95 < 300 ms |
| Self-service create (outage spike) | 30 creates/min for 10 min + 200 detail views/min | p95 < 800 ms, unique references, no 5xx |
| Directory search | 40 VUs typing (4 req/s each, debounced) | p95 < 300 ms local DB path |
| Job runner backlog | 5,000 queued notifications | drained < 10 min, no duplicates |

Run against staging (Neon `staging` branch) only with owner approval and data set to synthetic. Never against production. Record the Neon CU usage. Watch the pooler connection count (`connection_limit` × concurrent functions).

## 8. User acceptance testing (Phase 14)

- Scripts per persona: an employee reports an issue with a screenshot; an agent logs a phone call for an employee; triage assigns; an agent requests info (on hold); the employee replies; the agent resolves; the employee reopens; auto-close; a manager reviews the dashboard and exports CSV; an admin edits a group and SLA.
- Each script records expected vs actual, defects with severity, and sign-off by the IT manager.

## 9. Reporting rule for Sonnet

Each PR includes a "Tests run" section listing the exact commands, pass/fail counts copied from output, and anything not run with the reason (e.g. "Entra checklist not run: registration not yet provided [EXTERNAL]").
