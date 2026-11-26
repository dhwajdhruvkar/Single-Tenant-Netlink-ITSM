# SLA evaluation, routing, background jobs and admin configuration (Phase 8)

## Job runner (`modules/jobs/runner.ts`)
Stateless and database-backed: any number of web instances and workers can run it. Jobs are claimed with `FOR UPDATE SKIP LOCKED`, each with a
lease (`lockedUntil`, 5 min). Verified with real concurrency: two runners (and four) process every job exactly once.
- **Failure:** requeued with backoff `1 min × 2^(attempt−1)` capped at 1 h, error stored (truncated to 1,000 chars); `dead` after `maxAttempts` (8).
- **Crashes:** a job whose lease expired is claimed again; one that already used its last attempt is dead-lettered. A runner that lost its claim
  cannot overwrite the new owner's result (`finish` is conditional on `lockedBy`).
- **Only kinds with a registered handler are claimed.** Phases 5 and 7 already enqueue `notify.*` jobs; their handlers arrive in Phase 9. Until
  then those rows stay `queued` (nothing is failed or lost) and Phase 9 will pick up the backlog.
- Options: `maxJobs`, `budgetMs` (stop starting jobs after the budget), batch size.

## Schedules (`schedules.ts`)
`sla.evaluate` 1 min, `ticket.autoclose` 1 h, `attachments.cleanup` 24 h, `directory.delta` 30 min and `directory.full` 24 h (the last two only when
`DIRECTORY_SYNC_ENABLED` and Graph credentials are both set). A schedule enqueues one job per epoch-aligned slot; the slot is claimed by a conditional
`UPDATE JobSchedule.lastSlotAt` in the same transaction as the job insert. Many runners ⇒ one job per slot; a long outage fires once, not once per
missed slot. (Found by a test: concurrent first runs raced on a Prisma `upsert`; it is now `INSERT … ON CONFLICT DO NOTHING`.)

## Ways to run it
- `POST|GET /api/internal/jobs/run` with `Authorization: Bearer $CRON_SECRET`: runs due schedules and up to 50 jobs within 50 s. The comparison is
  constant-time and the endpoint is **closed** (401) unless `CRON_SECRET` is set and ≥ 32 characters; a session cookie is not accepted. GET is supported
  because Vercel Cron issues GET. No CSRF check (it has no cookie auth).
- `npm run worker` (`worker.ts`): the same pass in a loop every `WORKER_POLL_MS` (15 s), graceful on SIGTERM/SIGINT (a running pass finishes first).
  **Not yet packaged:** the production Docker image does not contain `worker.js`; bundling it is Phase 16. Run it with `tsx` for now.
- Inline dispatch (`JOBS_INLINE_DISPATCH`, default on): after ticket create/status/assignment/message responses, up to 10 due jobs are drained with
  Next's `after()`. An optimisation only; failures never affect the request.
- `infra/vercel.cron.json` is a **template**, not an active `vercel.json` (Phase 13 enables it for the new Vercel project only; a per-minute cron needs a
  paid plan, otherwise use an external scheduler hitting the endpoint).

## SLA evaluation (`sla/evaluate.ts`) and status (`sla/status.ts`)
- The status shown in the UI is **derived from timestamps on read** (`slaStatus`): a missed or late job never shows wrong data (asserted in a test and
  over HTTP: a ticket past its due date shows "breached" before any evaluation ran).
- `at risk` starts at **75%** of the window (the roadmap; Phase 7 had used the reference's 80%).
- The job marks `responseBreachedAt` / `resolveBreachedAt` once (conditional update), records a `sla_breached` event and enqueues
  `notify.sla_breached` (`dedupeKey {ticket}:breach:{response|resolve}`; resolve breaches carry `escalate: true`). It also enqueues
  `notify.sla_warning` once per window at ≥ 75%. Paused tickets, answered response windows, finished and archived tickets are skipped.
- **Escalation [OPEN]:** the default is "notify the group lead and managers on a resolve breach" — the recipient rules are Phase 9. There is
  **no automatic reassignment**.

## Auto-close (`tickets/autoClose.ts`)
Resolved, un-reopened tickets are closed by the system (actor `null`, audit actor type `job`) after `ticket.autoCloseDays` **working days**
(setting, default 5 [OPEN]). **Simplification:** working days are Monday–Friday in UTC; the company time zone and holidays are not applied. The
write is conditional on `status = resolved AND version`, so a ticket reopened in the meantime is left alone; two runners close each ticket once.

## Auto-assignment (`assignment/autoAssign.ts`)
Group strategy `manual` (default) | `round_robin` | `least_loaded`, applied when a ticket is created (no explicit assignee) and when moving a ticket to
another group clears its assignee. Candidates are members who are eligible, enabled, still in the directory and have an **active** account with role
agent or higher (so disabled people are skipped). Round robin advances `rrCursor` with one atomic `UPDATE … RETURNING` (30 parallel picks over 3 agents
is exactly 10 each). Least loaded counts open assigned tickets and breaks ties towards whoever has been waiting longest. An auto-picked assignee is not
subject to the manual "within your own groups" rule. A group with nobody available leaves the ticket unassigned.

## Admin configuration (`modules/admin/*`, `/api/admin/*`, `/admin/*`)
Groups (+ members, strategy, triage flag, active), categories (tree, types, default group/impact/urgency, active), SLA policies, business calendars
and holidays. **Admin only** (`config.manage`; membership uses `config.group_membership`, also admin by default [OPEN]); managers and agents get 403.
Every change is validated, runs in a transaction with its audit row (a failed audit write rolls the change back) and records before/after.
- Duplicate group/category/calendar names and a second active SLA policy for the same priority + type are 409. Category cycles and unknown parents are
  422. Members must be eligible, enabled, current people. Calendars need a valid IANA zone and a sensible day. Time-zone strings are validated.
- A policy change applies to tickets created (or re-prioritised) afterwards; existing due dates are kept.
- **Bug found and fixed:** Zod's `.partial()` keeps `.default()` values, so a PATCH of `{active:false}` would have reset a group's strategy and wiped a
  category's types and sort order. Update schemas are now built from default-free fields, with tests.
- UI: `/admin`, `/admin/groups`, `/admin/categories`, `/admin/sla` (server-side admin check; the API re-checks).

## Verification
Unit: backoff, slots, working days, cron auth (missing/short/wrong/unset secret ⇒ 401), worker loop (error tolerance, prompt abort, finishing the
current tick), SLA status table. Integration: runner concurrency/retry/dead-letter/leases/lost claims, schedule slot lease, SLA breach and warning
once-only, auto-close (weekends, races, setting), strategies and their integration with create/reassign, admin services. HTTP on the production
build: cron auth, a missed cron, once-only evaluation, inline dispatch on/off, admin API/pages by role. The worker process ran schedules, drained jobs
and stopped cleanly on SIGTERM.
**Not verified:** Vercel Cron itself, a long-running worker under load, several web instances sharing the runner, and the Docker worker packaging.
