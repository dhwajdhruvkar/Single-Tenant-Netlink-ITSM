# Document D — IMPLEMENTATION_ROADMAP.md
For: Claude Sonnet 5.5 Medium. Status: PLANNING ARTIFACT, executed only after approval.

## 0. Ordering rationale

Changes from the brief's suggested order:
- **Storage (P6) comes before core management (P7)**, because both creation forms need attachments. P5 ships the forms without attachments first, so the service contract is reviewed in isolation.
- **Jobs and SLA (P8) come before notifications (P9)**, because notifications are delivered by the job runner.
- **Approvals, change management, KB authoring, email intake and Teams move to P15 (Release 2).** Their company workflows are [OPEN]. Building them early risks inventing process.
- **Neon isolation (P12) and Vercel (P13)** stay late by default. They *may* be executed any time after P3 if the owner wants a staging demo, but each needs its approval gate. Development until then uses local Docker Postgres and `http://localhost:3000` (Entra accepts `http://localhost` redirect URIs).
- **Docker** is created in P0/P1 for local Postgres. The production Dockerfile is built in P1 and kept green in CI, so portability is continuously proven rather than left to P16.

Every phase ends with a PR to `main` and a stop for human review.

---

## 1. Repository workflow

| Location | Role | Allowed actions |
|---|---|---|
| `F:\Helpdesk - Integration` | Original reference | **Read only**: open files, `git status`, `git log`, `git diff`. No npm, prisma, git checkout/commit/push, or file edits |
| `dhwajdhruvkar/ticket-management-integration` | Original GitHub | Read only (browse/clone to a temp dir if needed) |
| `F:\ITSM-Netlink` | New implementation | All development |
| `dhwajdhruvkar/Single-Tenant-Netlink-ITSM` | **Only** GitHub write target | Branches, PRs, merges after review |

Git strategy:
- `main` is the protected default branch, holding stable integrated work. Settings: require PR, require CI, no force push.
- Branches: `phase/00-baseline`, `phase/01-foundation`, … `phase/05b-self-service-form`. Use `fix/<slug>` for fixes.
- Make small commits with conventional messages (`feat(tickets): …`, `chore: …`).
- Open a PR per phase, using the PR template created in P0 (Summary / Scope / Tests run with real output / Manual checks / Open decisions / Risks).
- The cloud-session branch `claude/busy-bardeen-suwcvz` (created by this planning session, with no commits) is not used for implementation. Start from `main`.

### Initial setup commands (PowerShell, Windows). Do not execute during planning.

```powershell
# 1. Verify the reference is not going to be touched (read-only status check)
git -C "F:\Helpdesk - Integration" status --short
git -C "F:\Helpdesk - Integration" log -1 --oneline     # record the commit; compare with GitHub 8cfb3eb
```

```powershell
# 2. Clone the new repo into the empty destination
git clone https://github.com/dhwajdhruvkar/Single-Tenant-Netlink-ITSM.git "F:\ITSM-Netlink"
```

```powershell
# 3. Create main (repo has no commits yet)
cd "F:\ITSM-Netlink"
git checkout -b main
```

```powershell
# 4. After Phase 0 files exist
git add -A
git commit -m "chore: project baseline"
git push -u origin main
```

```powershell
# 5. Every phase afterwards
git checkout main
git pull --ff-only
git checkout -b phase/01-foundation
```

Copy rule: copy individual files only, never directories, using the allow-list in Doc B §2/§3. After each copy, `git diff --stat` must show only the intended files. Never copy `.git`, `.vercel`, `.env*`, `node_modules`, `.next`, `.data`, `prisma/migrations`.

---

## 2. Phase plan

Each phase lists: Objective · Files · Reuse · Remove/replace · Dependencies · Steps · Contracts · Acceptance · Automated tests · Manual checks · Risks · Rollback · Deliverables.

### Phase 0 — Repository setup and project baseline
- **Objective:** an empty but buildable, lint-clean Next.js + TypeScript project with CI and the planning docs.
- **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.mjs` (headers only), `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`, `.gitignore` (from the original plus `/storage-local`), `.gitattributes`, `.editorconfig`, `.nvmrc` (`22`), `docker-compose.yml` (service `postgres:<version decided in [OPEN] — default 17>`; db `itsm_dev`; a second db `itsm_test`), `.env.example`, `README.md`, `CLAUDE.md` (short rules: the prohibitions from the handoff), `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `docs/planning/*` (this package), `src/app/layout.tsx`, `src/app/page.tsx` (placeholder).
- **Reuse:** dependency pins from the original (`next@16.3.7`, `react@19.0.0`, `next-auth@5.0.0-beta.31`, `zod@^4`, `vitest@4.1.11`, `prisma@6.19.3`, `tailwindcss@4`, `eslint@9`). [RECOMMENDATION] Keep the same versions first, which are proven to work together; upgrades are a separate PR.
- **Remove:** nothing is carried over except configs.
- **Steps:**
  1. Run `npm init` and install the pinned deps (no `framer-motion`/`pdfkit` yet).
  2. Add scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:integration`, `db:generate`, `db:migrate:dev` (local only), `db:migrate:deploy`, `db:studio`. **No `db:push`, no `db:reset` script.**
  3. CI: Node 22, `npm ci`, typecheck, lint, test, `npm audit --omit=dev`, build. A Postgres service container is added in P2.
  4. Enable branch protection on `main` (owner action, documented in README).
- **Acceptance:** `npm run typecheck && npm run lint && npm test && npm run build` pass locally and in CI. The repo has no secrets; `git ls-files | Select-String ".env"` shows only `.env.example`.
- **Tests:** one smoke unit test (`tests/unit/smoke.test.ts`).
- **Manual:** confirm `F:\Helpdesk - Integration` `git status` is unchanged from step 1.
- **Risks:** accidental copy of original files. **Rollback:** delete the branch.
- **Deliverables:** baseline commit on `main`, CI green.

### Phase 1 — Architecture and application foundation
- **Objective:** the modular monolith skeleton, config, errors, logging, HTTP helpers, Prisma client wiring, UI shell.
- **Files:**
  - Platform: `src/platform/config/env.ts` (zod schema for Doc D §4, `loadConfig()` fails fast), `src/platform/config/providers.ts`, `src/platform/errors.ts` (`AppError` subclasses: `ValidationError` 400, `UnauthenticatedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `RateLimitedError` 429), `src/platform/http/handler.ts` (`withApi(handler)`: request id, error mapping, JSON envelope `{data}`/`{error:{code,message,details}}`), `src/platform/http/pagination.ts`, `src/platform/logging/logger.ts`, `src/platform/db/prisma.ts` (singleton, `withTransaction`), `src/platform/clientIp.ts`, `src/platform/clock.ts`, `src/platform/rateLimit/dbRateLimit.ts` (stub until P2 table exists; P11 completes it).
  - Health: `src/app/api/health/route.ts` (liveness), `src/app/api/ready/route.ts` (DB `SELECT 1`).
  - UI: `src/ui/*` (shell, primitives).
  - Container: `Dockerfile` (standalone, non-root), `.dockerignore`.
  - Lint rule: `eslint` `no-restricted-imports` forbidding `next/*` and `@vercel/*` inside `src/modules/**`.
- **Reuse/adapt:** `server/http.ts` → `platform/http/*`; `observability/logger.ts`; `clientIp.ts`; `resilience.ts`; UI `AppShell`, `IconRail`, `TopBar` (strip persona/tenant), `primitives`, `ui`, `Toast`, `Skeleton`, `icons`, `globals.css`; security headers from `next.config.mjs`.
- **Remove/replace:** `config.ts` demo modes; the `*.neon.tech` env check.
- **Acceptance:**
  - App boots with `.env` pointing at local Docker PG.
  - `/api/health` returns 200 and `/api/ready` returns 200, or 503 when PG is down.
  - Invalid env makes startup fail with a readable message.
  - `docker build .` succeeds in CI.
- **Tests:** env schema (missing/invalid values), error mapping, pagination parsing, clientIp trust rules (port the original tests `graphTokenAndClientIp.test.ts` partially, `pagination.test.ts`).
- **Risks:** over-abstracting. Keep ports only where Doc A lists them.
- **Rollback:** revert the PR.

### Phase 2 — Database schema and single-company identity
- **Objective:** the Doc C baseline schema as migration `0001_baseline`, plus raw-SQL indexes/checks migration `0002_indexes_checks` and seed for **reference data only**.
- **Files:** `prisma/schema.prisma`, `prisma/migrations/0001_baseline/…`, `0002_indexes_checks/migration.sql`, `0003_db_roles.sql.template` (documented, applied by an operator later; not auto-run), `prisma/seed-reference.ts` (categories placeholder, one 24×7 calendar, default SLA policies marked `[OPEN]`, "Service Desk" triage group, company settings defaults; **no fake employees, no demo users**), `src/platform/db/guards.ts` (startup guard: refuse to run if the `Tenant` table exists or `_prisma_migrations` contains names not in this repo, which protects against pointing at the original DB), `tests/integration/setup.ts` (connects only if `DATABASE_URL` host ∈ {localhost, 127.0.0.1, postgres}; truncates the test DB between files).
- **CI:** add a `postgres` service, run `prisma migrate deploy` on the CI database, run `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` (drift check), then integration tests.
- **Commands allowed:** `npx prisma migrate dev --name baseline` **against local Docker only**. Never against Neon.
- **Acceptance:**
  - A fresh local DB migrates from empty.
  - The drift check passes.
  - The seed is idempotent (run twice, same rows).
  - The guard test proves the app refuses a DB with a `Tenant` table.
- **Tests (integration):**
  - Unique `Employee.entraObjectId`.
  - FK restrict on `Ticket.requesterEmployeeId`.
  - `(createdByEmployeeId, idempotencyKey)` unique.
  - The ticket number sequence increments under 20 parallel inserts with no duplicate references.
  - Check constraint on `holdReason`.
- **Risks:** Postgres version mismatch with the company [OPEN]. Use the most conservative version (16/17) until confirmed, and avoid PG18-only features.
- **Rollback:** local only; drop the local Docker volume.

### Phase 3 — Microsoft Entra authentication
- **Objective:** single-tenant OIDC sign-in, oid-based provisioning, app-role sync, per-request account check, sign-out, access-denied page.
- **External prerequisite [EXTERNAL]:** a dev app registration (Doc E §3) with redirect `http://localhost:3000/api/auth/callback/microsoft-entra-id`, app roles defined, and test users assigned. Until it exists, work on code and unit tests only. **No fallback credentials provider is ever added.**
- **Files:** `src/auth.config.ts` (edge-safe), `src/auth.ts`, `src/proxy.ts` (Next 16 middleware: pages → redirect `/signin`; `/api/*` → JSON 401), `src/app/signin/page.tsx` (one button), `src/app/access-denied/page.tsx`, `src/modules/identity/{actor.ts, requireActor.ts, permissions.ts, policies.ts, signInService.ts, roleMapping.ts}`, `src/types/next-auth.d.ts`, `src/app/api/me/route.ts`.
- **Implementation details:**
  - Provider: `MicrosoftEntraID({ clientId, clientSecret, issuer: \`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0\`, authorization: { params: { scope: "openid profile email User.Read" } } })`. Disable the profile photo fetch, or keep it but never store the photo.
  - `signIn({ account, profile })`: require `profile.tid === ENTRA_TENANT_ID` and that `profile.oid` matches a GUID. Call `signInService.handleSignIn({oid, tid, upn: profile.preferred_username, name, email, roles: profile.roles ?? []})`. It returns `{allowed, userAccountId, employeeId, sessionVersion}`, or redirects to `/access-denied?reason=…`.
  - `roleMapping`: `ITSM.Admin→admin`, `ITSM.Manager→manager`, `ITSM.Agent→agent`, `ITSM.Submitter→submitter`; default `employee`. Values are configurable via `ENTRA_ROLE_*` env.
  - JWT holds `{uaid, eid, sv}` only. `session.maxAge = 8h` [OPEN]; `updateAge = 1h`.
  - `requireActor(req, permission?)`: decodes the session, loads `UserAccount` + roles (one query), checks `status=active` and `sv === sessionVersion`, and returns `Actor {employeeId, userAccountId, role, groupIds}`. It throws 401/403. `groupIds` is loaded lazily for agents.
  - Mutating API routes check `Origin`/`Sec-Fetch-Site` against `APP_BASE_URL` (CSRF defence in depth).
  - Audit `auth.signin`, `auth.signin_denied` (with reason), and `auth.signout`.
- **Reuse:** the edge/node split pattern, `authorized` callback, and `next-auth.d.ts` from the original.
- **Remove:** Credentials providers, `DEMO_MODE`, `PUBLIC_DEMO_AUTH`, `LOCAL_ACCOUNT_AUTH`, impersonation, API-key actor.
- **Acceptance:**
  - With a real dev registration: sign-in works; first sign-in creates `Employee` + `UserAccount`; roles reflect the Entra assignment; a user from another tenant is denied.
  - Disabling the account in the DB → the next API call returns 401.
  - Bumping `sessionVersion` → 401.
- **Tests (unit):**
  - roleMapping (unknown roles ignored, highest wins).
  - `tid` mismatch is denied.
  - Missing `oid` is denied.
  - `requireActor` status/version checks.
  - The permission matrix as a table-driven test of all roles × all permissions vs Doc C §3.2.
- **Tests (integration):** signInService upsert idempotency (same oid, changed UPN/mail → same Employee).
- **Manual:** the Entra checklist in Doc G §5.
- **Risks:**
  - Auth.js beta API changes. Pin the exact version.
  - Group overage is not an issue because app roles are used.
- **Rollback:** revert. No data migration involved.

### Phase 4 — Employee directory integration
- **Objective:** Graph-backed sync and search, and the self profile.
- **External prerequisite [EXTERNAL]:** a daemon app registration (or the same app) with **application** permission `User.Read.All` and admin consent.
- **Files:** `src/modules/directory/{ports.ts (DirectoryProvider: getUser(oid), searchUsers(q, limit), delta(cursor)), graph/graphClient.ts, graph/graphDirectoryProvider.ts, graph/token.ts (from graphToken.ts), mapping.ts (Graph user → Employee fields; dept/location resolution), eligibility.ts, syncService.ts, searchService.ts, profileService.ts}`, `src/app/api/directory/employees/route.ts`, `src/app/api/directory/employees/[id]/route.ts`, `src/app/api/me/profile/route.ts`, `src/modules/directory/fakeDirectoryProvider.ts` (**tests only**, never wired in production config).
- **Graph details:**
  - `$select=id,displayName,givenName,surname,mail,userPrincipalName,employeeId,jobTitle,department,officeLocation,businessPhones,mobilePhone,accountEnabled,userType,employeeType,companyName`.
  - Manager: `/users/{id}/manager?$select=id` during the full sync only (rate-friendly).
  - Search: `GET /users?$search="displayName:{q}" OR "mail:{q}" OR "userPrincipalName:{q}"&$top=10` with header `ConsistencyLevel: eventual`.
  - Delta: `/users/delta`, with the `deltaLink` stored in `JobSchedule.cursor`.
  - Handle 429 using `Retry-After`. Apply timeouts using `resilience.ts`.
- **Eligibility [OPEN]:** default `userType == "Member" && accountEnabled && (mail || upn) && !upn.startsWith("svc-")`, configurable via `DIRECTORY_ELIGIBILITY_*` (e.g. a required `companyName`, or membership in an "All employees" group via `GroupMember.Read.All`).
- **Search API:** `GET /api/directory/employees?q=&limit=10`
  - Permission `directory.search` (submitter+). `q` is ≥ 2 chars.
  - Searches the local DB first (trigram/prefix on name, mail, UPN, employeeNumber; eligible & enabled only).
  - If there are fewer than 3 results and `q` is ≥ 3 chars, it calls the Graph fallback, upserts, and re-queries.
  - Response: `{data:[{id, displayName, mail, userPrincipalName, employeeNumber, jobTitle, department, officeLocation}]}`. `entraObjectId` is not exposed (not needed).
  - Rate-limited to 30/min per user.
- **Profile API:** `GET /api/me/profile` returns the same shape for the actor's own Employee and refreshes from Graph if `lastSyncedAt` is more than 24 h old (failure is non-fatal). Missing fields return `null`, and the UI shows "Not provided in directory".
- **Acceptance:**
  - A full sync of the dev tenant populates Employees.
  - A second (delta) run changes only modified users.
  - A disabled user → `accountEnabled=false` and their `UserAccount` is disabled.
  - Search returns within 300 ms locally for 2,000 seeded fake rows (integration test with the fake provider).
- **Tests:**
  - mapping (all-null fields, dept/location resolution, guest exclusion).
  - search ranking and limits.
  - The Graph fallback is called only under the threshold.
  - 429 retry.
  - Token cache concurrency (port `graphTokenConcurrency.test.ts`).
- **Risks:**
  - `User.Read.All` consent delays [EXTERNAL].
  - Incomplete directory data.
- **Rollback:** disable the sync schedule via `DIRECTORY_SYNC_ENABLED=false`.

### Phase 5A — Shared ticket creation service (backend only)
- **Objective:** `createTicket(command, actor)` and the two endpoints, without attachments.
- **Files:** `src/modules/tickets/{contracts.ts (zod), createTicket.ts, reference.ts, priority.ts (from domain/priority.ts), stateMachine.ts (P7 completes), access.ts, repo.ts, dto.ts}`, `src/modules/audit/auditWriter.ts`, `src/modules/jobs/enqueue.ts` (writes `Job` rows inside the tx; the runner comes in P8), `src/modules/sla/dueDates.ts` (port the calendar walker from `slaService.ts` now, because creation sets dues), `src/modules/assignment/routing.ts` (category→default group; null → triage), `src/app/api/tickets/self/route.ts`, `src/app/api/tickets/assisted/route.ts`.
- **Contract (`contracts.ts`):**
```ts
const Common = z.object({
  type: z.enum(["incident","service_request"]),
  categoryId: z.string().uuid().optional(),
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(20000),
  impact: z.enum(["low","medium","high"]).optional(),
  urgency: z.enum(["low","medium","high"]).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  locationNote: z.string().trim().max(160).optional(),
  typeDetails: z.unknown().optional(),           // sanitised by type (ticketTypes.ts)
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
}).strict();                                       // .strict() → unknown keys (e.g. requesterEmployeeId) = 400
export const SelfServiceCreate = Common;
export const AssistedCreate = Common.extend({
  requesterEmployeeId: z.string().uuid(),
  channel: z.enum(["phone","walk_in","email","teams","chat"]),
  priorityOverride: z.object({ priority: z.enum(["p1","p2","p3","p4"]), reason: z.string().trim().min(3).max(500) }).optional(),
  assignmentGroupId: z.string().uuid().optional(),
  assigneeEmployeeId: z.string().uuid().optional(),
}).strict();
// Service command (internal, never parsed from HTTP directly):
type CreateTicketCommand = Omit<z.infer<typeof Common>,"attachmentIds"> & {
  requester: { kind: "self" } | { kind: "employee"; employeeId: string };
  channel: TicketChannel; priorityOverride?; assignmentGroupId?; assigneeEmployeeId?;
  attachmentIds: string[]; idempotencyKey?: string;
};
```
- **Service algorithm:**
  1. Resolve the requester. `self` → `actor.employeeId`. `employee` requires `can(actor,'ticket.create.on_behalf')`; load the Employee, which must be `isEligible && accountEnabled && !directoryDeletedAt` (else 422 `REQUESTER_NOT_ELIGIBLE`).
  2. Idempotency: if `idempotencyKey` is set and a ticket with `(createdBy, key)` exists, return it with `replayed=true`.
  3. Validate the category (active, allows the type), `typeDetails` (port `ticketTypes.ts` sanitiser), and the assignee (must be a member of the target group).
  4. Impact/urgency default to the category defaults, else medium/medium. `priority = matrix(impact, urgency)`. An override is only allowed for agent+ and needs a reason; set `priorityOverridden`.
  5. Routing: an explicit group (agent+ only), else the category default group, else the triage group. The assignee is explicit only (auto-assign strategies come in P8).
  6. SLA: select the active policy for (priority, type), compute `responseDueAt`/`resolveDueAt` from `createdAt` with the calendar.
  7. In **one transaction**:
     - Insert the ticket (status `assigned` if an assignee is set, else `new`), with requester snapshots from the Employee row, and `createdByEmployeeId = actor.employeeId`.
     - Set the reference.
     - Insert `TicketEvent(created, data:{channel, onBehalf: requester≠creator})`.
     - Insert `AuditLog(ticket.create)`.
     - Enqueue `notify.ticket_created` (requester) and `notify.ticket_assigned` (group/assignee) jobs with `dedupeKey = ticketId:event`.
  8. Return `TicketDetailDTO`.
- **Endpoints:**
  - `POST /api/tickets/self` → 201 `{data:{id, reference}}`, or 200 with the `Idempotency-Replayed: true` header. Permission `ticket.create.self`. 10/min per user.
  - `POST /api/tickets/assisted` → same response. Permission `ticket.create.on_behalf`. 30/min per user.
  - Errors: 400 validation (with field paths), 403, 409 idempotency conflict (same key, different body hash), 422 requester not eligible.
- **Acceptance:**
  - Both endpoints create tickets with correct requester/creator.
  - Self-service rejects any `requester*` field (400).
  - Assisted by an `employee` role → 403.
  - The duplicate key replays.
- **Tests:** see Doc G §3.1 for the full list (≥ 25 cases), including concurrency for 50 parallel creates (unique references) and the transaction rollback when the audit insert fails (no orphan ticket).
- **Risks:** duplication creep between endpoints. A review checklist item: endpoints ≤ 40 lines each and no business rules.
- **Rollback:** revert.

### Phase 5B — Form B: employee self-service UI
- **Files:** `src/app/(employee)/my/tickets/new/page.tsx` (server component loads `/me/profile` data via the profile service directly), `src/ui/tickets/RequesterCard.tsx` (read-only), `src/ui/tickets/TicketFormFields.tsx` (shared fields: type, category picker, subject, description, impact/urgency as plain-language questions from the original `affectedPeople`/`workStopped`, contact phone, location note), `src/ui/tickets/useCreateTicket.ts` (generates the Idempotency-Key per form mount), `src/app/(employee)/my/tickets/page.tsx` (my tickets list, minimal; full version in P7).
- **Rules:**
  - The requester card renders the profile with read-only fields; there are **no hidden requester inputs**.
  - After submit, redirect to `/my/tickets/{reference}` with a success toast.
  - Accessibility: labels, error summary, keyboard-only flow.
- **Acceptance:** a signed-in employee sees their name, email, department, title and office. Missing values show a placeholder. Submit creates a ticket where requester = creator.
- **Tests:**
  - Component test (Vitest + Testing Library): the card is read-only, no requester fields are in the request payload.
  - E2E in P14.

### Phase 5C — Form A: agent-assisted UI
- **Files:** `src/app/(agent)/desk/tickets/new/page.tsx`, `src/ui/directory/EmployeeSearch.tsx` (adapted `RequesterPicker.tsx`: 250 ms debounce, keyboard navigation, shows dept/title/office, "no results" with a Graph-fallback notice), `src/ui/tickets/RequesterCard.tsx` (reused), `src/ui/tickets/AgentOnlyFields.tsx` (channel, priority override with reason, group, assignee filtered by group).
- **Rules:**
  - The form submits only `requesterEmployeeId` for the requester. The card is display-only.
  - Changing the selected employee clears the card.
  - Show "Created by: <agent>" read-only.
  - Show "Recent tickets for this employee" (last 5, via `GET /api/tickets?requesterEmployeeId=…`, agent+) [RECOMMENDATION] to avoid duplicates.
- **Acceptance:** an agent finds an employee, creates a ticket, and the ticket shows requester Jane and created-by the agent. An employee-role user gets 403 when opening `/desk/tickets/new` (server-side check in the page and the API).
- **Tests:** component test for the search interaction; contract test that the payload has no snapshot fields.

### Phase 6 — Attachments and storage
- **Objective:** the `ObjectStorage` port, the temporary DB provider, validation, staged upload, secure download, cleanup.
- **Files:** `src/modules/attachments/{ports.ts, providers/databaseStorage.ts, providers/localDiskStorage.ts (dev only; throws if NODE_ENV=production), providers/s3Storage.ts (stub + tests behind interface, optional now), providers/azureBlobStorage.ts (adapt original SharedKey/SAS; no container auto-create in prod), validation.ts (from attachmentService: allowlist, blocked extensions, magic bytes), scanner.ts (MalwareScanner port; NoopScanner returns not_scanned), keys.ts, service.ts (stage, link, read, softDelete)}`, `src/app/api/attachments/route.ts` (POST multipart), `src/app/api/attachments/[id]/route.ts` (GET), and an update to `createTicket` and the P7 message API to link `attachmentIds`.
- **Port:**
```ts
interface ObjectStorage {
  readonly provider: "database"|"s3"|"azure_blob"|"local";
  put(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  get(key: string): Promise<{ body: Buffer | NodeJS.ReadableStream; contentType: string } | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}
```
- **Key format:** `itsm/{APP_ENV}/att/{yyyy}/{mm}/{uuid}`, validated by `^itsm\/(local|staging|production)\/att\/\d{4}\/\d{2}\/[0-9a-f-]{36}$`.
- **Rules:**
  - Max size `ATTACHMENT_MAX_BYTES`, with a hard cap of 4 MB when `STORAGE_PROVIDER=database` or on Vercel.
  - Max 10 per ticket create.
  - Linking: only `staged` rows uploaded by the same actor, uploaded within 24 h.
  - Download:
    - Requires `canViewTicket`.
    - Internal-message attachments are hidden from non-agents (404, not 403).
    - Response headers: `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
    - Each download writes an `audit attachment.download` entry.
    - If `ATTACHMENT_REQUIRE_CLEAN_SCAN=true` [OPEN], `scanStatus` must be `clean`.
  - Cleanup: job `attachments.cleanup` deletes staged rows older than 24 h and their objects, and soft-deleted objects older than 30 days [OPEN].
- **Acceptance:**
  - Upload → create a ticket with attachments → download works for requester and agent.
  - Another employee gets 404.
  - An EXE is rejected.
  - A PNG renamed to PDF is rejected.
  - A row's `storageKey` begins with `itsm/`.
- **Tests:** provider contract test suite (run against the database provider and the local-disk provider; the same suite later runs against S3/Azure using an emulator — MinIO/Azurite — only in a dedicated CI job), validation table tests (port the original `attachments.test.ts` cases), authorization tests.
- **Risks:**
  - Neon size quota with DB storage.
  - Vercel 4.5 MB body limit.
- **Rollback:** the feature flag `ATTACHMENTS_ENABLED=false` hides the UI and rejects uploads with 503.

### Phase 7 — Core ticket management
- **Objective:** lists, detail, lifecycle, assignment, conversation, internal notes, archive.
- **Files:** `src/modules/tickets/{queries.ts (adapt ticketSql.ts), stateMachine.ts, updateTicket.ts, assign.ts, messages.ts, archive.ts}`, the API routes `GET /api/tickets`, `GET /api/tickets/[ref]`, `PATCH /api/tickets/[ref]` (`{version, priority?, impact?, urgency?, categoryId?, type?, reason?}`), `POST /api/tickets/[ref]/status` (`{version, to, holdReason?, resolutionCode?, resolutionNotes?, reason?}`), `POST /api/tickets/[ref]/assignment` (`{version, groupId?, assigneeEmployeeId?|"me"|null}`), `POST /api/tickets/[ref]/messages` (`{body, visibility, attachmentIds[]}`), `POST /api/tickets/[ref]/archive`; UI `(agent)/desk` (queue views: My tickets, My groups, Unassigned (triage), All (manager), Breaching soon), `(agent)/desk/tickets/[ref]`, `(employee)/my/tickets`, `(employee)/my/tickets/[ref]`; polling hook (adapt `useLiveRefresh.ts`).
- **State machine:**

  | From \ To | assigned | in_progress | on_hold | resolved | closed | cancelled |
  |---|---|---|---|---|---|---|
  | new | ✔ (assign) | ✔ | ✔ | ✔ | — | ✔ |
  | assigned | — | ✔ | ✔ | ✔ | — | ✔ |
  | in_progress | ✔ (reassign) | — | ✔ | ✔ | — | ✔ |
  | on_hold | ✔ | ✔ | — | ✔ | — | ✔ |
  | resolved | — | ✔ (reopen) | — | — | ✔ (confirm / auto) | — |
  | closed / cancelled | terminal | | | | | |

  Notes:
  - `on_hold` with `awaiting_requester` pauses the SLA (port `slaPausePatch`); other hold reasons pause per [OPEN] config.
  - A public agent reply records `firstRespondedAt`.
  - An employee reply on an `awaiting_requester` hold returns the ticket to `in_progress`.
  - Reopen is allowed within `ticket.reopenWindowDays` (default 7) [OPEN].
- **Concurrency:** every PATCH/POST includes `version`. The update uses `WHERE id=? AND version=?` and returns 409 `STALE_VERSION` otherwise.
- **Access:** `access.ts` builds a Prisma `where` for list queries (never post-filters) and is reused by `canViewTicket`.
- **Acceptance:**
  - All transitions are enforced.
  - Internal notes never appear in employee API responses (assert on raw JSON).
  - Queues show the correct sets for each role.
  - Two agents taking the same ticket: one gets 409.
- **Tests:** state machine exhaustive table test; access policy matrix integration test (5 roles × 6 ticket relationships); message visibility; pagination; search.
- **Risks:**
  - Explorer complexity. Ship the four queues and basic filters (status, priority, group, assignee, category, date range, text) first.

### Phase 8 — SLA, routing and background jobs
- **Objective:** the job runner, schedules, SLA evaluation, auto-assignment strategies, escalation (basic), auto-close, directory sync scheduling.
- **Files:** `src/modules/jobs/{runner.ts (claim with FOR UPDATE SKIP LOCKED; time budget; backoff 1m·2^n capped 1h; dead after maxAttempts), schedules.ts (code table: sla.evaluate 1m, directory.delta 30m, directory.full 24h, attachments.cleanup 24h, ticket.autoclose 1h), handlers/index.ts}`, `src/app/api/internal/jobs/run/route.ts` (`Authorization: Bearer ${CRON_SECRET}`, timing-safe compare, ≥32-char secret; runs schedules + up to N jobs within 50 s), `worker.ts` (root; loop every 15 s; graceful SIGTERM), `src/modules/sla/{evaluate.ts, status.ts}`, `src/modules/assignment/{roundRobin.ts, leastLoaded.ts}` (adapt `groupService.ts`), the admin UI for groups/members/categories/SLA policies/calendars `(admin)/…`, and `vercel.json` cron entry (infra file, P13 enables).
- **SLA rules:**
  - `slaStatus(ticket, now)` is a pure function: `ok | warning (≥75% elapsed) | breached`, computed on read.
  - The job sets `responseBreachedAt`/`resolveBreachedAt` once and enqueues `notify.sla_warning`/`notify.sla_breached` with dedupe keys `ticket:breach:resolve`.
- **Escalation [OPEN]:** default on resolve breach → notify the group lead + managers. No automatic reassignment.
- **Auto-close:** resolved tickets with no reopen after `ticket.autoCloseDays` (default 5 business days [OPEN]) → closed by the system actor.
- **Acceptance:**
  - Running the runner twice concurrently processes each job once (integration test with two parallel runners).
  - A missed cron still shows correct SLA status in the UI.
  - Round-robin skips disabled members.
- **Tests:** SLA calculator (port `sla.test.ts`, `slaPause.test.ts`), runner concurrency, backoff, dead-lettering, schedule slot lease, the cron endpoint auth (missing/short/wrong secret → 401).

### Phase 9 — Notifications and Microsoft integration
- **Objective:** in-app notifications, email via Graph, and templates. Teams is in P15.
- **Files:** `src/modules/notifications/{dispatcher.ts, recipients.ts, templates/*.ts (adapt notify/templates.ts; plain HTML + text), ports.ts (MailSender), providers/graphMailSender.ts (POST /users/{SUPPORT_MAILBOX}/sendMail), providers/smtpMailSender.ts (optional, nodemailer — only if company IT prefers SMTP relay [OPEN]), providers/noopMailSender.ts (logs; default in local)}`, `GET /api/notifications`, `POST /api/notifications/read`, a UI bell with polling every 60 s, and `src/ui/notifications/*`.
- **Events → recipients (launch):**
  - created → requester (and creator if different: "Ticket logged for Jane").
  - assigned → assignee or group members (in-app only for groups).
  - public reply → the other party.
  - resolved → requester (with confirm/reopen link).
  - SLA warning/breach → assignee + group lead.
  - on_hold awaiting requester → requester.
- **Rules:**
  - Email failures retry via jobs.
  - Never email internal notes.
  - Links use `APP_BASE_URL`.
  - The user preference "email me" defaults to on [OPEN].
- **Graph permission:** `Mail.Send` (application), **scoped to the support mailbox** using Exchange RBAC for Applications [EXTERNAL].
- **Acceptance:** each event produces exactly one in-app notification per recipient and one email job. Disabling `EMAIL_PROVIDER` (noop) does not break flows.
- **Tests:** recipient rules matrix, template rendering snapshot, HTML escaping (subject with `<script>`), Graph sender payload, retry.

### Phase 10 — Dashboards and reporting
- **Objective:** employee, agent and manager dashboards, plus CSV export.
- **Files:** `src/modules/reporting/{queries.ts (SQL aggregates: open by status/priority/group, created vs resolved per day, MTTR, first response time, SLA compliance %, backlog age, per-agent resolved count & median time; adapt metricsService.ts / agentPerformance.ts semantics, actual resolver = resolvedByEmployeeId)}`, `GET /api/reports/summary?from&to&groupId`, `GET /api/reports/export.csv?…` (manager+, streamed, max 50k rows, audit `report.export`), UI pages `(agent)/desk/dashboard`, `(admin)/reports`, and the employee "My tickets" summary.
- **Charts:** use a lightweight library or inline SVG [RECOMMENDATION]; no heavy BI.
- **Acceptance:** numbers match hand-computed fixtures. Agents see team scope only. CSV formulas are escaped (prefix `'` for `=+-@`).
- **Tests:** aggregate correctness on fixed fixtures, scope enforcement, CSV injection.

### Phase 11 — Security and performance hardening
- **Objective:** an RBAC audit, API security, file security, DB optimisation, load test, multi-instance checks.
- **Tasks:**
  1. Route inventory test: enumerate every `src/app/api/**/route.ts` and assert each exported handler goes through `withApi` + `requireActor` (or is on an explicit public list: health, ready, auth, internal-jobs with secret).
  2. IDOR suite (Doc G §4).
  3. DB rate limiter on all mutating endpoints.
  4. CSP tightening and header tests.
  5. `audit_log` grants: SQL file for `itsm_app` without UPDATE/DELETE (applied in P12/P13 by an operator).
  6. `EXPLAIN ANALYZE` on the top 10 queries with 50k synthetic tickets; add or adjust indexes.
  7. k6 load test (Doc G §7).
  8. Dependency audit.
  9. Secrets scan (gitleaks in CI).
  10. Logging review: no tokens, emails only where needed, request ids.
- **Acceptance:** zero unguarded routes; p95 targets met locally; gitleaks clean.

### Phase 12 — Neon isolation and database activation [APPROVAL GATE]
Follow `DATABASE_RESET_RUNBOOK.md` exactly. Summary:
- Gate 12.0: the owner approves the **new Neon project** option in writing.
- 12.1: create the Neon project `netlink-itsm` (region and PG version per [OPEN]) with branches `main` and `staging`, and roles `itsm_migrator` and `itsm_app`. **No action on `netlink-support`.**
- 12.2: run `prisma migrate deploy` with `DIRECT_URL` → `staging`, then verify (`_prisma_migrations` = repo list; tables present; the guard passes). Seed reference data.
- 12.3: apply the grants SQL.
- 12.4: repeat for `main` only after staging UAT sign-off.
- Destructive steps: **none** in the recommended path. Any destructive step needs a separate confirmation naming the project, branch and database.

### Phase 13 — New Vercel project [APPROVAL GATE]
Follow `INFRASTRUCTURE_AND_DEPLOYMENT.md` §4.
- Create the project `netlink-itsm` linked **only** to `dhwajdhruvkar/Single-Tenant-Netlink-ITSM`.
- Set env vars per scope.
- Add the staging Entra redirect URI.
- Deploy a preview from `main`, then verify health, sign-in, both forms, attachments, notifications and cron.
- Pre-check: confirm the original project `netlink-support` is unchanged (same Git repo link and last deployment) before and after.

### Phase 14 — Testing and production readiness
- The full Doc G suite.
- UAT with IT staff using real (non-demo) accounts on staging.
- Go-live checklist (Doc E §6).
- A runbook for incidents.
- Sign-off.

### Phase 15 — Release 2 (each a separate PR, each needs confirmed requirements)
- 15.1 Knowledge base (articles, versions, full-text search, employee search + "suggested articles" on Form B by keyword).
- 15.2 Service catalog items with forms and approvals (manager approval via Graph `manager`).
- 15.3 Change management (ChangeRequest, CAB approvals, calendar).
- 15.4 Email intake (Graph polling of the support mailbox, adapt `graphEmail.ts`, `emailIngest.ts`, `emailThreading.ts`; unmatched senders held).
- 15.5 Teams notifications via Workflows webhooks per group.
- 15.6 Canned responses, ticket links/merge, CSAT.
- 15.7 Resolution confirmation email links (adapt `ticketAcknowledgement.ts`).
- 15.8 AI classification only if approved [OPEN].

### Phase 16 — Company-server migration preparation
See `INFRASTRUCTURE_AND_DEPLOYMENT.md` §5. Deliverables:
- Verified Docker image and `docker-compose.prod.example.yml` (web + worker + external PG).
- S3 and/or Azure storage provider completed and tested with emulators.
- `scripts/migrate-storage.ts`.
- DB migration runbook.
- DR runbook.
- A break-glass admin procedure (SQL to grant `admin` manual role, audited).

---

## 3. Per-phase definition of done (applies to all)

1. Typecheck, lint, unit and integration tests pass, with real command output pasted into the PR.
2. There are no TODOs without an issue link.
3. New env vars are added to `.env.example` and the env schema.
4. Docs are updated (`docs/` module notes).
5. Open decisions encountered are listed in the PR.
6. No change outside `F:\ITSM-Netlink`.

## 4. Environment-variable contract (placeholders only)

| Variable | Local dev | Vercel Preview (staging) | Vercel Production | Company server | Notes |
|---|---|---|---|---|---|
| `APP_ENV` | `local` | `staging` | `production` | `production` | Also the storage key namespace |
| `APP_BASE_URL` | `http://localhost:3000` | `https://<staging-host>` | `https://<prod-host>` | `https://itsm.<company-domain>` | Links, CSRF origin |
| `DATABASE_URL` | `postgresql://itsm:itsm@localhost:5432/itsm_dev` | Neon `staging` **pooled** URL, role `itsm_app`, `?sslmode=require&pgbouncer=true&connection_limit=5` | Neon `main` pooled, `itsm_app` | Company PG (via PgBouncer if any), `itsm_app` | Runtime |
| `DIRECT_URL` | same as above | Neon `staging` **direct**, role `itsm_migrator` — **not set in Vercel runtime**; used only by the migration job | same rule | Company PG direct, migrator | Migrations only |
| `AUTH_SECRET` | random ≥32 bytes | `<secret>` | `<secret>` (different) | `<secret>` | Auth.js |
| `AUTH_TRUST_HOST` | `true` | `true` | `true` | `true` behind a trusted proxy | |
| `AUTH_URL` | optional | `https://<staging-host>` | `https://<prod-host>` | `https://itsm.<company-domain>` | |
| `ENTRA_TENANT_ID` | `<tenant-guid>` | same | same | same | Single tenant |
| `ENTRA_CLIENT_ID` | `<dev-app-id>` | `<staging-app-id>` | `<prod-app-id>` | `<prod-app-id>` | Sign-in app |
| `ENTRA_CLIENT_SECRET` | `<secret>` | `<secret>` | `<secret>` | from secret manager | Or certificate later |
| `ENTRA_ROLE_AGENT` / `_MANAGER` / `_ADMIN` / `_SUBMITTER` | `ITSM.Agent` … | same | same | same | App role values |
| `GRAPH_TENANT_ID` | `<tenant-guid>` | same | same | same | Daemon app |
| `GRAPH_CLIENT_ID` | `<daemon-app-id>` | … | … | … | |
| `GRAPH_CLIENT_SECRET` | `<secret>` | … | … | … | |
| `DIRECTORY_SYNC_ENABLED` | `false` (or `true` with a dev tenant) | `true` | `true` | `true` | |
| `DIRECTORY_ELIGIBILITY_COMPANY_NAME` | empty | [OPEN] | [OPEN] | [OPEN] | Optional filter |
| `STORAGE_PROVIDER` | `local` or `database` | `database` | `database` → later `s3`/`azure_blob` | `s3` / `azure_blob` / [OPEN] | |
| `ATTACHMENT_MAX_BYTES` | `10485760` | `4194304` | `4194304` | `26214400` [OPEN] | |
| `ATTACHMENT_REQUIRE_CLEAN_SCAN` | `false` | `false` | [OPEN] | [OPEN] | |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | — | — | if S3-compatible | Future |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`, `AZURE_STORAGE_SAS_TOKEN` (container-scoped) | — | optional | optional | if Azure | Never account keys if avoidable |
| `EMAIL_PROVIDER` | `noop` | `graph` or `noop` | `graph` | `graph` / `smtp` | |
| `SUPPORT_MAILBOX` | — | `<support-mailbox>` | `<support-mailbox>` | same | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | — | — | — | if SMTP [OPEN] | |
| `TEAMS_NOTIFICATIONS_ENABLED` | `false` | `false` | R2 | R2 | Webhook URLs stored as secrets `TEAMS_WEBHOOK_<GROUPKEY>` |
| `CRON_SECRET` | random | `<secret>` | `<secret>` | not needed with worker (keep for manual trigger) | ≥32 chars |
| `JOBS_INLINE_DISPATCH` | `true` | `true` | `true` | `false` (worker does it) | `after()` dispatch |
| `WORKER_POLL_MS` | `15000` | — | — | `15000` | worker.js |
| `APP_ROLE` | `web` | — | — | `web` or `worker` | Docker entrypoint |
| `TRUST_PROXY_HEADERS` | `0` | auto (Vercel) | auto | `1` only behind a trusted proxy | |
| `LOG_LEVEL` | `debug` | `info` | `info` | `info` | JSON stdout |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | — | optional | [OPEN] | Future monitoring |
| `SESSION_MAX_AGE_HOURS` | `8` | `8` | `8` [OPEN] | same | |

Rules:
- Production values are never in a file.
- The migrator `DIRECT_URL` never goes to the long-running runtime. If Prisma refuses to load without the variable at runtime (verify this in Phase 1 with the pinned Prisma version), set the runtime `DIRECT_URL` to the same `itsm_app` URL as `DATABASE_URL`. The migration job overrides it with the migrator URL.
- Staging and production use different secrets and different Entra app registrations [RECOMMENDATION].
