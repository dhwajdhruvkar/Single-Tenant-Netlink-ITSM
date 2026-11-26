# Netlink ITSM (single-company) — Planning Package Index & Handoff

Status: **PLANNING ARTIFACT — not approved for implementation yet.**
Prepared: 2026-11-26. Target repository: `dhwajdhruvkar/Single-Tenant-Netlink-ITSM`.
Reference (read-only): `dhwajdhruvkar/ticket-management-integration` @ `8cfb3eb`.

Recommended location once approved: commit this folder to the new repository as
`docs/planning/` in Phase 0 (the only files Phase 0 commits besides tooling).

| Doc | File | Purpose |
|---|---|---|
| A | `SOLUTION_ARCHITECTURE.md` | Target architecture, flows, temporary vs future hosting |
| B | `FEATURE_REUSE_MATRIX.md` | What is reused, adapted, rewritten or dropped, plus launch classification |
| C | `DATABASE_DESIGN.md` | New schema, keys, indexes, identity mapping |
| D | `IMPLEMENTATION_ROADMAP.md` | Phased tasks for Sonnet, Git workflow, env contract |
| E | `INFRASTRUCTURE_AND_DEPLOYMENT.md` | Neon/storage/Vercel isolation and the later move to company servers |
| F | `DATABASE_RESET_RUNBOOK.md` | Approval-gated isolation, backup and (last-resort) reset |
| G | `TESTING_STRATEGY.md` | Unit, integration, E2E, Entra, security, migration and load tests |

Classification labels used throughout: **[CONFIRMED]** requirement from the brief,
**[RECOMMENDATION]** engineering recommendation, **[ASSUMPTION]**, **[OPEN]** decision,
**[EXTERNAL]** dependency on company IT or a vendor, **[VERIFIED]** observed during
this investigation (read-only).

---

## 1. What the investigation actually found (verified, read-only)

1. **New repository is empty.** Branch `claude/busy-bardeen-suwcvz` has no commits; no `main` exists locally. Nothing is there to preserve.
2. **Original repository** (`netlink-support` package; Next.js 16.3.7, React 19, Auth.js 5 beta.31, Prisma 6.19.3, Zod 4, Vitest 4) is a multi-tenant app with a **dual persistence layer** (in-memory/JSON `MemoryStore` plus `PrismaStore` behind a generic `Collection<T>` port). Many reads are filtered in application memory.
3. **Neon:** the account has **one** project, `netlink-support` (`wild-mouse-14431497`, AWS ap-southeast-1, **Postgres 18**). It has **one** branch, `production` (`br-dry-block-azib222r`, default, **not protected**), with one database, `neondb`. That database holds the **original application's live data**: 2 tenants, 13 users, 32 tickets, and the last ticket update on 2026-11-11. The compute was active on 2026-11-26. History retention is **6 hours**.
   → **The original app and any "reuse the existing Neon" plan point at the same database. Resetting it would destroy the original application's data.** See Doc F.
4. **"Blob Storage" is actually Postgres.** All 12 attachment rows use `db://` locators, with 12 rows in `AttachmentBlob` and **0 Azure URLs**. The original runs `ATTACHMENT_STORAGE=database`, so attachment bytes live in the **same Neon database**. An Azure SharedKey adapter exists in code but holds no data. A database reset would therefore also delete every attachment.
5. **Migration drift in the original:** Neon has 7 migrations applied. Repo migration `20261113090000_performance_indexes` is **not applied** there. This is only an observation for the original's owner; nothing should be done to the original.
6. A `neon_auth` schema exists in `neondb` (Neon Auth provisioned, 0 users). It is unrelated to either app, so leave it alone.
7. **Vercel:** the original is live at `https://netlink-support.vercel.app`. The project settings could **not** be inspected: the Vercel connector returned 403 for scope `dhwaj-s-projects` (team access not authorised). Whether the original's env vars include an Azure connection string, a cron or a Neon integration is **unverified**. The Phase 13 pre-check covers it.
8. **Identity gaps in the original** that the new design must fix:
   - Entra users are matched and provisioned **by email**. `externalId` stores `providerAccountId`, which is the pairwise `sub` claim, **not** the stable `oid`.
   - There is no `tid` (tenant) check beyond the issuer URL.
   - Roles live only in the DB. Entra app roles are not used.
   - Tickets store `requesterEmail` (required) and `requesterId` (optional). **No "created by" column exists.** Agents can file for any free-text email address, even one that is not in the directory.
   - Requester search loads every user and filters in memory.
9. **Runtime gaps:**
   - The rate limiter is in-process.
   - SSE uses an in-process `EventEmitter`, so it is single-instance only.
   - The scheduler runs on `setInterval` from `instrumentation.ts`, which is not reliable on serverless.
   - `jobs/lock.ts` uses a session-level `pg_try_advisory_lock`, which is unsafe behind PgBouncer transaction pooling. The newer `durableLease.ts` row lease is the right pattern.
   - Ticket references are random 6-hex strings (`INC-9F2A1C`), so a collision fails ticket creation.
   - The production env check hard-requires a `*.neon.tech` host, which is Neon lock-in.
10. **README vs source:**
    - The README calls Entra the production path, but production defaults to `LOCAL_ACCOUNT_AUTH=true` (organization code + password).
    - `PUBLIC_DEMO_AUTH` can expose six demo identities.
    - Teams "integration" is an incoming webhook plus a Graph presence lookup, not a bot.
    - Email intake supports Graph polling or Brevo.
    - AI uses Gemini, Groq or Azure OpenAI, with a hashed bag-of-words embedder as fallback.
    - Malware scanning is an empty seam (`scanAttachment`).

## 2. Recommended phase execution order

```
P0 Repo baseline ─► P1 Foundation ─► P2 Schema+identity ─► P3 Entra auth ─► P4 Directory
   ─► P5 Shared ticket creation (5A service, 5B self-service form, 5C agent form)
   ─► P6 Attachments & storage ─► P7 Core ticket mgmt ─► P8 SLA, routing, jobs
   ─► P9 Notifications ─► P10 Dashboards & reporting ─► P11 Security & performance
   ─► P12 Neon isolation & DB activation [APPROVAL GATE] ─► P13 New Vercel project [APPROVAL GATE]
   ─► P14 Test & production readiness / UAT ─► R1 LAUNCH
   ─► P15 Release 2 (approvals, change mgmt, KB authoring, email intake, Teams)
   ─► P16 Company-server migration preparation
```

Changes from the suggested order (reasons are in Doc D §0):
- Storage moves before core management because Form A and Form B need attachments.
- Jobs and SLA move before notifications because notifications are delivered by jobs.
- Approvals and change management move to Release 2 because their company workflows are unconfirmed.
- P12 and P13 can be pulled forward to any point after P3 for stakeholder demos, but only once their gates are approved.

## 3. Most important architectural decisions

1. **Modular monolith** on Next.js (App Router, Node runtime), with domain modules under `src/modules/*`. A single Prisma/Postgres data layer replaces the memory/JSON driver and the generic `Collection` port.
2. **Ports only at infrastructure edges:** `ObjectStorage`, `MailSender`, `TeamsNotifier`, `DirectoryProvider`, `MalwareScanner`, `JobRunner trigger`, `Clock`. Core logic never imports Vercel, Neon or Azure SDKs.
3. **Identity:** `Employee` is the directory record, keyed by **Entra `oid`**. `UserAccount` is application access (role, status, session version). Every person FK points to `Employee.id`. Tickets carry `requesterEmployeeId` **and** `createdByEmployeeId`, plus requester snapshot fields.
4. **Entra app roles** (`ITSM.Agent`, `ITSM.Manager`, `ITSM.Admin`, optional `ITSM.Submitter`) arrive in the ID token, are synced to the DB at sign-in, and are enforced only on the server. The `tid` and `oid` claims are validated explicitly.
5. **One `createTicket` application service** handles both forms. Two thin endpoints, `/api/tickets/self` and `/api/tickets/assisted`, differ only in how the requester is resolved. The self-service endpoint ignores and rejects any requester input.
6. **Correctness never depends on a long-running process.** SLA state is derived from timestamps on read. Side effects go through a **transactional outbox / job table** drained by a stateless runner, triggered by Vercel Cron now and by a worker container later. Rate limits are stored in the DB. The UI polls instead of using in-process SSE.
7. **New, separate Neon project** for the new app. The original Neon project is **not touched**, so no reset is needed. See Doc F.
8. **Temporary attachments use a Postgres-backed storage provider inside the new, isolated database**, matching what the original does today. They sit behind `ObjectStorage`, with an S3-compatible or Azure provider added before production volumes.

## 4. Highest-risk operations

| # | Operation | Why it is risky | Control |
|---|---|---|---|
| 1 | Any DROP, TRUNCATE, `migrate reset` or `db push` on `wild-mouse-14431497/production/neondb` | Destroys the original app's tickets **and** attachments; 6 h history only | Forbidden. Use a new Neon project; reset only by the runbook after the original is decommissioned, with written approval |
| 2 | Pointing the new app's `DATABASE_URL` at the original DB, even for "read only" testing | Prisma migrations would mutate the original schema | Startup guard: refuse to boot if the DB contains a `Tenant` table or `_prisma_migrations` rows not in this repo |
| 3 | Granting Graph `User.Read.All` / `Mail.Send` application permissions | Tenant-wide read; Mail.Send can send as any mailbox | Admin consent by company IT; Exchange RBAC-for-Applications scope to the support mailbox |
| 4 | Linking the new repo to the original Vercel project, or reusing its env vars | Could redeploy over `netlink-support.vercel.app` | New project only; verify the Git link before the first deploy |
| 5 | Running `prisma migrate deploy` against the Neon prod branch of the new project | Schema changes in production | Manual, gated GitHub Action or operator step with `DIRECT_URL`; never in `build` |
| 6 | Entra role misconfiguration | Over-privileged access | Default role = Employee; server-side enforcement; RBAC matrix tests |
| 7 | Copying files from `F:\Helpdesk - Integration` | Leaks `.env`, `.vercel`, `.git` or tenant data | Allow-list copy procedure (Doc D, Phase 0) |

## 5. Information we must obtain from company IT

**Entra / Microsoft 365**
1. Tenant ID and verified domains. Who creates the app registrations, and the naming convention.
2. Whether separate registrations per environment (local/staging/prod) are allowed.
3. The redirect URI host for staging and production, and whether a `*.vercel.app` host is acceptable temporarily.
4. Client secret vs certificate policy, secret lifetime and rotation owner.
5. App-role assignment model: which security groups map to Agent, Manager, Admin and Submitter. Whether "assignment required" is on, so only assigned users can sign in. Which group means "all employees".
6. Admin consent for Graph application permissions: `User.Read.All`, `Mail.Send` (scoped), and optionally `Mail.ReadWrite` for intake.
7. Which directory objects count as employees: exclude guests, shared mailboxes, service accounts, rooms. Are `employeeId`, `department`, `officeLocation` and `manager` reliably populated?
8. Conditional Access and MFA policies that apply to the app, plus session lifetime expectations.
9. The support mailbox address, and whether Exchange RBAC for Applications or an Application Access Policy can be applied.
10. Whether Teams notifications are wanted, by channel; Workflows (Power Automate) webhooks vs a bot.

**Infrastructure (future)**
11. Application server OS, container runtime (Docker, Podman or an orchestrator), reverse proxy and TLS termination.
12. **PostgreSQL major version** (decides the Postgres version for the new Neon project), pooling (PgBouncer?), allowed extensions (`pgcrypto`, `pg_trgm`, `citext`), HA, backups.
13. Object storage product (S3-compatible? Azure Blob? NFS share?), auth method, private networking.
14. Secrets manager, logging/monitoring stack, alerting destination.
15. Outbound network rules: `login.microsoftonline.com`, `graph.microsoft.com`, the Teams webhook hosts.
16. RPO/RTO, data retention and legal-hold rules for tickets and audit, and data residency (current Neon region is Singapore).
17. Malware scanning service available (Defender, ClamAV/ICAP, other) and the policy for unscanned files.

**Business (open decisions)**
18. Ticket categories and subcategories, assignment groups, and category→group routing.
19. SLA targets per priority, business hours, holidays and time zone(s).
20. Whether HR tickets are in scope; if so, a confidential visibility model is needed.
21. Whether agents see all IT tickets or only their groups' queues.
22. Whether any service requests need approval, and who approves (line manager from Graph `manager`?).
23. Whether change management is needed at launch, and CAB membership.
24. Whether AI-assisted classification is approved, and with which provider (data leaves the company).
25. Ticket reference format, auto-close period after resolution, reopen window.

## 6. Handoff instruction for Claude Sonnet 5.5 Medium

> You are implementing the Netlink single-company ITSM application from the approved planning package in `docs/planning/`. Work **only** in `F:\ITSM-Netlink`, which is the clone of `dhwajdhruvkar/Single-Tenant-Netlink-ITSM`.
>
> `F:\Helpdesk - Integration` and `dhwajdhruvkar/ticket-management-integration` are **read-only references**. Never write, commit, push, checkout branches or run npm/prisma commands there. Copy code only through the allow-list procedure in Doc D, Phase 0.
>
> Execute **one phase at a time**, in the order in `IMPLEMENTATION_ROADMAP.md`. For each phase:
> 1. Create the branch `phase/<nn>-<slug>` from an up-to-date `main`.
> 2. Implement only that phase's scope.
> 3. Run `npm run typecheck && npm run lint && npm test` (and `npm run test:integration` from Phase 2 onward, against **local Docker Postgres only**).
> 4. Report exactly which commands ran and their real results.
> 5. Open a PR to `main`, then stop for review.
>
> Never claim a test, build or migration passed unless you ran it and saw it pass. A green build is not production readiness.
>
> **Hard prohibitions:**
> - Never run `prisma migrate reset`, `prisma db push`, `DROP`, `TRUNCATE`, or any destructive SQL against any Neon database.
> - Never touch Neon project `wild-mouse-14431497` (`netlink-support`) at all.
> - Never modify the original Vercel project.
> - Never commit secrets or populated `.env` files.
> - Never add demo, local-password or self-registration sign-in.
> - Never trust requester identity or roles sent by the browser.
> - Never use email as the identity key; `Employee.entraObjectId` is the key.
> - Phases 12 and 13 require the owner's **explicit written approval** before any cloud resource is created. Any destructive database step requires a **second, separate confirmation** naming the exact project, branch and database.
>
> When something is marked **[OPEN]** or **[EXTERNAL]**, implement the documented default behind configuration and list it in the PR description. Do not invent company workflow.
