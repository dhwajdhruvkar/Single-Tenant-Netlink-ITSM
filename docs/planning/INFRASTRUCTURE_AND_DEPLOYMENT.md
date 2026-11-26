# Document E — INFRASTRUCTURE_AND_DEPLOYMENT.md
Status: PLANNING ARTIFACT. No resource described here has been created.

## 1. Current state (verified read-only on 2026-11-26)

| Resource | Finding | Implication |
|---|---|---|
| Neon project `netlink-support` (`wild-mouse-14431497`) | AWS ap-southeast-1, PG 18, autoscaling 0.25–2 CU, branch size limit 1 GiB, history retention 6 h, IP allowlist empty, public connections allowed | The original app's live DB |
| Branch `production` (`br-dry-block-azib222r`) | Only branch; default; **not protected**; 37 MB; active today | Shared by definition with any "reuse" plan |
| Database `neondb` (owner `neondb_owner`) | Original schema (Tenant, User, Ticket…, `AttachmentBlob`), 7 of 8 repo migrations applied, 2 tenants / 13 users / 32 tickets / 12 attachments; `neon_auth` schema present (0 users) | Reset = original data loss |
| Attachment storage | 12 rows, all `db://` → stored in `AttachmentBlob` in `neondb`; 0 Azure URLs | "Existing Blob Storage" = Postgres database mode |
| Azure Blob | Adapter in code (SharedKey via connection string; creates container `attachments` on first use) but no stored objects | Whether an Azure account exists is **unverified** |
| Vercel | Original live at `netlink-support.vercel.app` (from repo docs); project settings not inspectable (connector 403 on scope `dhwaj-s-projects`) | Env vars, cron, integrations **unverified**; check before Phase 13 |

## 2. Temporary infrastructure — target design

### 2.1 Database (Neon) — **new project, not a reset**

[RECOMMENDATION] **Option A (preferred):** create a new Neon project `netlink-itsm`.
- **Region:** near users and the Vercel function region [OPEN]. The users are likely US-based ("Netlink Software Group America"), but this must be confirmed. The old project is in Singapore.
- **Postgres major version:** match the company's future PG [OPEN]. The default is 17 if unknown.
- **Branches:**
  - `main` is production for the new app, marked **protected**.
  - `staging` is a child of `main` created *before* any data exists, so it is empty.
  - Local dev uses Docker, not Neon.
- **Roles:** `itsm_migrator` (owner), `itsm_app` (runtime).
- **Database:** `itsm`.
- **Settings:**
  - Enable an IP allowlist only if the Vercel egress is static (otherwise not possible on Vercel; document it).
  - Increase history retention if the plan allows (≥ 24 h for staging and ≥ 7 d for production).
  - Configure scheduled snapshots if available.

**Option B (fallback if the plan limits projects):**
- Create a new **root branch** `itsm-main` in the existing project, starting empty with no parent data (use the "schema-only/empty" init option if the Neon plan offers it). If it does not, branch from `production` and then drop only the copied original objects **on that new branch** — never on `production`.
- Add a new database `itsm` and roles `itsm_migrator`/`itsm_app` on that branch.
- Isolation is weaker: same project, same owner and admins, same compute quotas.

**Option C (rejected):** a new database inside `production`. It shares the compute and the branch with the original app.

**Option D (rejected):** reset `neondb`. It destroys the original app's tickets and attachments.

### 2.2 Attachment storage (temporary)

- [VERIFIED] The original uses Postgres-stored blobs. The new app continues the same *capability* with `STORAGE_PROVIDER=database`, which writes to the `StoredObject` table **in the new database**. It is therefore isolated from the original by construction: there is no shared container and no shared table.
- Keys are namespaced `itsm/{APP_ENV}/att/...`, so a later bulk copy to object storage keeps meaningful paths.
- Limits: 4 MB/file (Vercel request body limit is 4.5 MB). Neon branch size quota (1 GiB on the current plan, verify for the new project).
- If the owner prefers real blob storage now (an Azure storage account exists or will be created):
  - Use a **separate storage account** for the new app, or at minimum a **new private container** `itsm-staging` / `itsm-production`.
  - Authenticate with a **container-scoped SAS token** (racwdl, short expiry, rotated), never the account key. A SharedKey connection string grants the entire account, including any original containers.
  - Pre-create the container. The app must not auto-create containers in production (unlike the original adapter).
  - Never list, overwrite or delete any pre-existing container.

### 2.3 Vercel — new project

See §4.

## 3. Microsoft Entra configuration (company IT performs; values are placeholders)

### 3.1 Sign-in app registration: one per environment [RECOMMENDATION]
- Name `Netlink ITSM – <Env>`, supported account types **Accounts in this organizational directory only (single tenant)**.
- **Redirect URIs (Web):**
  - Local: `http://localhost:3000/api/auth/callback/microsoft-entra-id`
  - Staging: `https://<staging-host>/api/auth/callback/microsoft-entra-id`
  - Production: `https://<prod-host>/api/auth/callback/microsoft-entra-id`
- **Front-channel logout URL:** `https://<host>/signin?signedOut=1`.
- Implicit grant: **off**. Public client flows: **off**.
- **Credentials:** a client secret (≤ 6–12 months, stored only in Vercel or the secret manager) for staging. Certificate credentials are a future option for production [EXTERNAL policy]. Auth.js uses `client_secret_post`/`basic` by default; certificate (private_key_jwt) needs custom client configuration, so it is to be evaluated in Phase 16.
- **API permissions (delegated):** `openid`, `profile`, `email`, `User.Read`.
- **Token configuration:** ensure the ID token includes `email` (optional claim), `preferred_username`, `oid` and `tid` (default in v2). App roles are emitted in `roles`.
- **App roles** (allowed member type: Users/Groups):
  - `ITSM.Agent`
  - `ITSM.Manager`
  - `ITSM.Admin`
  - optional `ITSM.Submitter`
  - optional `ITSM.User`
- **Enterprise application settings:**
  - **Assignment required = Yes** [RECOMMENDATION], with "All employees" assigned `ITSM.User` and IT groups assigned their roles. This limits sign-in to intended people.
  - Conditional Access (MFA, compliant device) is owned by company policy [EXTERNAL].

### 3.2 Directory / mail daemon app registration
- Application permissions:
  - `User.Read.All`: directory search and sync (department, jobTitle, officeLocation, employeeId, manager).
  - `Mail.Send`: notifications.
  - Release 2, if email intake is approved: `Mail.ReadWrite`.
  - Optional: `GroupMember.Read.All`, only if eligibility is defined by group.
- Admin consent by a Global/Privileged Role Administrator [EXTERNAL].
- **Restrict mailbox scope** with Exchange Online RBAC for Applications (or an Application Access Policy), so `Mail.Send`/`Mail.ReadWrite` work only for `SUPPORT_MAILBOX`.
- Credential: a client secret (temporary) or certificate. Separate from the sign-in app, so the web sign-in secret cannot read the directory.

### 3.3 Validation implemented by the app
- Issuer `https://login.microsoftonline.com/{ENTRA_TENANT_ID}/v2.0`, audience = client ID, signature via JWKS, nonce, PKCE, state (Auth.js/oauth4webapi).
- An explicit `tid === ENTRA_TENANT_ID` check.
- `oid` as the key. Emails are not trusted for identity.

## 4. New Vercel project — steps (Phase 13, after approval)

**Pre-check:**
1. Authorise the Vercel connector or CLI for the right team scope.
2. List projects and record the original project's name, linked repo (`dhwajdhruvkar/ticket-management-integration`), production domain and latest deployment ID.
3. Record whether it uses a Neon integration, an `AZURE_STORAGE_CONNECTION_STRING`, or crons. **Do not change it.**

**Create:**
4. "Add New → Project", import **`dhwajdhruvkar/Single-Tenant-Netlink-ITSM` only**, project name `netlink-itsm` (must differ from `netlink-support`).
5. Framework Next.js; Root Directory `./`; Install `npm ci`; Build `npm run build` (**migrations are not part of the build**); Node.js 22.x.
6. Function region: the same as the Neon project region.
7. **Do not** add the Neon marketplace integration (it can create or attach databases automatically). Set env vars manually.
8. Environment variables (Doc D §4):
   - Preview scope → Neon `staging` pooled `itsm_app` URL, staging Entra app, `APP_ENV=staging`.
   - Production scope → Neon `main` (only after UAT), production Entra app.
   - Different `AUTH_SECRET` and `CRON_SECRET` per scope.
   - Mark sensitive values as sensitive.
9. Deployment Protection: keep Vercel Authentication on previews. Production is protected by Entra sign-in.
10. Cron (`vercel.json`): `{"crons":[{"path":"/api/internal/jobs/run","schedule":"* * * * *"}]}`. Per-minute cron needs Vercel Pro [EXTERNAL]. On Hobby, use the daily cron plus `JOBS_INLINE_DISPATCH` and an external scheduler (e.g. a GitHub Actions `schedule` every 5 min calling the endpoint with the secret), and document the degraded timing. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set.
11. Migrations: run `npx prisma migrate deploy` from a trusted machine or a manual GitHub Action (`workflow_dispatch`, environment-protected), with the migrator `DIRECT_URL` for the target branch. Do this before promoting a deployment that needs the schema.

**Validate:**
12. `/api/health` returns 200 and `/api/ready` returns 200.
13. Sign-in with test users for each role.
14. Run Form B, Form A, an attachment upload/download, a notification and the cron run (job table drains).
15. Verify that response headers are present.
16. Re-check that the original project's latest deployment ID and domain are unchanged.

**Later migration away from Vercel:** §5. Remove `vercel.json` crons when the worker is live.

## 5. Future company-server migration strategy

| Area | Plan |
|---|---|
| Runtime | Multi-stage Dockerfile (Next standalone). Entrypoint script: `APP_ROLE=web` → `node server.js`; `APP_ROLE=worker` → `node worker.js`. Non-root UID 1001; read-only root FS supported (no local writes when `STORAGE_PROVIDER≠local`). Health `/api/health`, readiness `/api/ready` |
| Scaling | 1–2 web replicas + 1 worker. Stateless; no sticky sessions. DB rate limiter; job SKIP LOCKED |
| Env vars | Same contract (Doc D §4); injected from the company secret manager |
| PostgreSQL | 1) Company provisions PG (same major version as the Neon project) with roles `itsm_migrator`/`itsm_app`. 2) Maintenance window: set the app read-only (`MAINTENANCE_MODE=true` returns 503 on mutations). 3) `pg_dump -Fc --no-owner --no-privileges` from the Neon direct URL. 4) `pg_restore` into company PG. 5) Re-apply grants. 6) Verify row counts per table + `_prisma_migrations` equality + checksum of `StoredObject` sizes. 7) Switch `DATABASE_URL`. 8) Smoke test. 9) Keep Neon read-only for N days, then archive |
| Blob storage | Implement `S3ObjectStorage`/`AzureBlobObjectStorage` (or the company's provider) behind the existing port. Run `scripts/migrate-storage.ts`: for each `Attachment` where `storageProvider=database`, copy the object to the target with the same key, verify sha256, then update `storageProvider` per row in batches (idempotent, resumable). Delete `StoredObject` rows only after full verification and owner approval |
| Entra | Add the production redirect URI for `https://itsm.<company-domain>` to the production app registration; remove `*.vercel.app` URIs after cutover. Update `APP_BASE_URL`/`AUTH_URL` |
| DNS/TLS | Company DNS record → reverse proxy; TLS cert from the company CA/ACME; HSTS. `TRUST_PROXY_HEADERS=1` only when the proxy overwrites `X-Forwarded-For` |
| Background worker | The worker container replaces Vercel Cron; set `JOBS_INLINE_DISPATCH=false` (optional) |
| Monitoring | JSON logs to stdout → company log stack; alert on `/api/ready` failures, the job `dead` count > 0, the oldest queued job age > 5 min, and 5xx rate. Optional OpenTelemetry |
| Backup & DR | PG: daily full + WAL/PITR per company standard [OPEN RPO/RTO]; quarterly restore test. Object storage: versioning/soft delete enabled. Secrets: documented rotation. Runbook: restore DB to point-in-time → verify → repoint app |
| Network | Outbound allow: `login.microsoftonline.com`, `graph.microsoft.com`, the Teams webhook host(s). Inbound only via the proxy |

## 6. Go-live checklist (Phase 14)

- [ ] The Entra production app registration exists; roles are assigned; assignment-required is on; CA policies are applied.
- [ ] Graph admin consent is granted; mailbox scope restriction is verified (sending from another mailbox fails).
- [ ] The Neon `main` branch is protected, migrations are applied and verified, grants are applied, and a backup/snapshot schedule is set.
- [ ] Production env vars are complete; the env check passes; there is no `DIRECT_URL` migrator URL in the runtime.
- [ ] Cron or the external scheduler is running; the job queue drains; there are no dead jobs.
- [ ] Reference data is loaded (categories, groups, SLA, calendar, holidays) as confirmed by IT.
- [ ] Directory sync is complete; the employee count matches IT's expectation.
- [ ] UAT is signed off; the security test suite is green; the load test meets targets.
- [ ] The original `netlink-support` project/DB is verified unchanged.
