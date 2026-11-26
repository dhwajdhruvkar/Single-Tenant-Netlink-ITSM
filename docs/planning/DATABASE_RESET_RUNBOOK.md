# Document F — DATABASE_RESET_RUNBOOK.md
Approval-gated Neon isolation, backup and reset procedure. Status: PLANNING ARTIFACT. **Nothing in this runbook has been executed.**

## 0. Bottom line

[VERIFIED] The "existing Neon database" (`netlink-support` / `production` / `neondb`) is the **original application's live database**. It contains its tickets **and its attachment bytes** (`AttachmentBlob`). There is only one branch, it is unprotected, and point-in-time history is only **6 hours**.

**Decision [RECOMMENDATION]:** do **not** reset it. Provision a **new Neon project** for the new app (Section 3). The "reset" then becomes "initialise an empty, separate database", which is not destructive at all.

A reset of the original database (Section 6) is documented only as a last-resort procedure. It is allowed **only** after the original application is formally decommissioned by its owner. It requires two written approvals and a verified off-platform backup.

## 1. Roles and approvals

| Gate | Who approves | Evidence required |
|---|---|---|
| G1 — Isolation option chosen (A/B) | Project owner | Written choice in the PR or issue |
| G2 — New resources may be created | Project owner | Region, PG version, plan confirmed |
| G3 — Migrations to `staging` | Reviewer | PR merged; CI green; migration list |
| G4 — Migrations to `main` (prod) | Project owner | UAT sign-off on staging |
| G5 — **Any destructive operation** on any branch | Project owner, **separately**, naming project ID + branch ID + database | Verified backup (Section 4.3) + a decommission statement for the original app if it targets its DB |

Sonnet must stop and ask at every gate. Approval of this plan is **not** approval of G5.

## 2. Identity verification (run before every DB step, read-only)

1. Print the target from the connection string without the password: host, database, role. The endpoint ID in the host (`ep-…`) must belong to the intended project/branch. Check it with the Neon console or API: *Project → Branch → Compute endpoint ID*.
2. Read-only SQL against the target:
```sql
SELECT current_database(), current_user, inet_server_addr(), version();
SELECT to_regclass('public."Tenant"') AS original_marker,      -- must be NULL for the new app DB
       to_regclass('public."AttachmentBlob"') AS original_blob_marker;
SELECT migration_name FROM _prisma_migrations ORDER BY started_at;  -- must be empty or only new-repo names
```
3. **Stop conditions:**
   - `original_marker` is not null.
   - The host contains the original project's endpoint.
   - The database is `neondb` on branch `br-dry-block-azib222r`.
   - Any migration name starts with `2026…` (the original's migrations).

   The app's startup guard (Phase 2) enforces the same checks.

## 3. Provisioning or isolation (non-destructive) — recommended path

### Option A — new project (preferred)
1. G1 + G2 approved.
2. Create the Neon project `netlink-itsm` (region and PG major version per [OPEN] decisions). Do this in the Neon console, or by an operator with the Neon API/MCP `create_project`. Sonnet does not do it without G2.
3. Rename the default branch to `main`. Mark it **protected**.
4. Create the database `itsm`. Create roles `itsm_migrator` (owner of `itsm`) and `itsm_app`.
5. Create the branch `staging` from `main` while `main` is still empty.
6. Record the project ID, branch IDs, endpoint IDs and the pooled/direct hosts in the private ops notes (not in Git).
7. Run the identity verification (Section 2) on both branches. All markers must be null and the migration list empty.

### Option B — new root branch in the existing project (only if A is impossible)
1. G1 + G2 approved, with the reason A is impossible recorded.
2. Create branch `itsm-main` **without parent data**, if the plan supports schema-only or empty branches. Otherwise follow B-alt.
3. **B-alt:**
   - Create `itsm-main` from `production` (a copy-on-write copy).
   - Create a new database `itsm` on `itsm-main` and use it exclusively. Do not drop anything on the copied `neondb`.
   - The copied `neondb` on the new branch remains as dead weight. Optionally delete it later under G5, naming branch `itsm-main` explicitly. **Never** on `production`.
4. Protect `itsm-main`. Create the roles and the `staging` child branch as in A.

Result for either option: the original `production/neondb` is untouched, and no reset is needed.

## 4. Backup (required before G5; recommended once anyway as a safety record of the original)

Even though the recommended path does not touch the original database, take one verified backup of it before any Neon work begins. This protects against operator error during provisioning.

### 4.1 Neon-native safety copy (instant, same project)
- Create a branch `backup-original-YYYYMMDD` from `production` at the current point in time.
- Do not connect any app to it. Optionally protect it.
- Limitation: it lives in the same project. It does not protect against project deletion or account issues.

### 4.2 Off-platform logical dump
Requirements: `pg_dump`/`pg_restore` **version 18** (the server is PG 18; older clients refuse), and the **direct** (non-pooler) endpoint with a read-only-capable role. A newly created read-only role is preferred.

```bash
# placeholders only; run from a trusted workstation, never commit outputs
export PGURL='postgresql://<role>:<password>@<endpoint>.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'
pg_dump "$PGURL" --format=custom --no-owner --no-privileges --file=netlink-support-neondb-YYYYMMDD.dump
pg_dump "$PGURL" --schema-only --file=netlink-support-neondb-YYYYMMDD.schema.sql
sha256sum netlink-support-neondb-YYYYMMDD.dump > netlink-support-neondb-YYYYMMDD.dump.sha256
```

Store the dump encrypted (e.g. 7-Zip AES-256 or a company vault) in two locations. It contains personal data, so treat it as confidential.

### 4.3 Backup verification (all must pass)
1. `pg_restore --list <dump>` lists the tables in `public` and `neon_auth`.
2. Restore into a scratch local container:
   ```bash
   docker run --rm -d --name verify -e POSTGRES_PASSWORD=verify -p 55432:5432 postgres:18
   createdb -h localhost -p 55432 -U postgres verify
   pg_restore -h localhost -p 55432 -U postgres -d verify --no-owner <dump>
   ```
3. Compare against the source (read-only query on both):
```sql
SELECT 'Tenant' t, count(*) FROM "Tenant" UNION ALL SELECT 'User', count(*) FROM "User"
UNION ALL SELECT 'Ticket', count(*) FROM "Ticket" UNION ALL SELECT 'TicketMessage', count(*) FROM "TicketMessage"
UNION ALL SELECT 'TicketEvent', count(*) FROM "TicketEvent" UNION ALL SELECT 'Attachment', count(*) FROM "Attachment"
UNION ALL SELECT 'AttachmentBlob', count(*) FROM "AttachmentBlob" UNION ALL SELECT 'AuditRecord', count(*) FROM "AuditRecord"
UNION ALL SELECT '_prisma_migrations', count(*) FROM _prisma_migrations;
SELECT sum(length(data)) AS blob_bytes, md5(string_agg(id || md5(data), ',' ORDER BY id)) AS blob_digest FROM "AttachmentBlob";
SELECT max("updatedAt") FROM "Ticket";
```
   Baseline observed on 2026-11-26: Tenant 2, User 13, Ticket 32, Attachment 12, AttachmentBlob 12, `_prisma_migrations` 7.
4. Counts and digest are equal. The sha256 of the dump file is recorded.
5. Destroy the scratch container.

## 5. Schema initialisation and migration (new database only)

1. Confirm G3 (staging) or G4 (main).
2. Run the identity verification (Section 2) against the target. Markers must be null.
3. `DIRECT_URL=<migrator direct URL of target> DATABASE_URL=<same> npx prisma migrate status` → expect "no migrations applied" on first run.
4. `npx prisma migrate deploy` (never `migrate dev`, `db push` or `migrate reset` against Neon).
5. Apply `0003_db_roles` grants as `itsm_migrator`.
6. Run `npm run db:seed:reference`, which is idempotent and loads reference data only.
7. **Data verification:**
   - `prisma migrate status` reports "Database schema is up to date".
   - `_prisma_migrations` equals the repo folder list.
   - Tables equal Doc C.
   - Reference rows are present.
   - `itsm_app` cannot `UPDATE "AuditLog"` (expect a permission error).
   - The app `/api/ready` returns 200.
8. Rollback: on a fresh empty database, the rollback is to delete and recreate the *new* branch (G5 naming the new branch). On a database with data, write a forward-fix migration. Never use `migrate reset`.

## 6. Reset of the original database — LAST RESORT ONLY (not recommended)

Preconditions, **all** required:
1. The owner states in writing that `netlink-support.vercel.app` is decommissioned, or has been moved to another database, and that its data may be discarded.
2. The original Vercel project's `DATABASE_URL` no longer points at this branch, and the production deployment is paused or removed (verified).
3. Section 4.1 and 4.2 backups exist, and Section 4.3 verification passed within the last 24 h.
4. G5 approval quotes: project `wild-mouse-14431497`, branch `br-dry-block-azib222r`, database `neondb`, and the exact command.

Procedure (preferred: replace rather than drop):
- **Preferred:** create a new database `itsm` on the branch, and leave `neondb` in place, renamed `neondb_archived_YYYYMMDD` via `ALTER DATABASE` after disconnecting sessions. Then follow Section 5 against `itsm`. Nothing is dropped.
- **Only if the owner insists on reusing the name `neondb`:** after the steps above, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` in `neondb`, executed by the operator, **not** Sonnet, after reading the statement back to the owner. **Do not touch `neon_auth`** without separate confirmation.
- After either path: run Section 2 and Section 5. Keep the backup for the retention period agreed with the owner.

## 7. Separation summary

| Step | Destructive? | Who | Gate |
|---|---|---|---|
| Backup (4.1, 4.2) | No | Operator / Sonnet with approval | G2 |
| Backup verification (4.3) | No (scratch container only) | Operator / Sonnet | — |
| Provisioning / isolation (3) | No | Operator | G1, G2 |
| Reset (6) | **Yes** | Operator only | G5 + decommission |
| Schema initialisation (5.4) | Additive on an empty DB | Sonnet/operator | G3/G4 |
| Migration (future releases) | Additive by policy; destructive changes need a separate review | CI manual job | Per release |
| Data verification (5.7) | No | Sonnet | — |
