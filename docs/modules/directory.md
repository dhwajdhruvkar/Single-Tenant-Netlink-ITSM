# Employee directory (Phase 4)

`Employee` rows are the company directory, keyed by Entra `oid`. They exist before anyone signs in, so a requester who has never
used the app can still be selected by an agent.

## Pieces
- `ports.ts` — `DirectoryProvider` (`getUser`, `searchUsers`, `delta`, `getManagerOid`). Only `GraphDirectoryProvider` is wired in
  production (`src/platform/directory.ts`, which returns `null` when `GRAPH_*` is not configured). `fakeDirectoryProvider.ts` is a
  **test double only**.
- `graph/token.ts` — client-credentials token with cache and in-flight de-duplication (reused from the reference implementation).
- `graph/graphClient.ts` — GET with timeout, bearer token and bounded retry on 429/503 honouring `Retry-After` (wait capped at 60 s).
  Refuses any URL that is not `https://graph.microsoft.com`, so a hostile `nextLink` cannot receive the bearer token.
- `graph/graphDirectoryProvider.ts` — the `$select` list from the plan; `$search` with `ConsistencyLevel: eventual`; delta paging;
  manager via `/users/{id}/manager?$select=id`.
- `mapping.ts`, `eligibility.ts`, `syncService.ts`, `searchService.ts`, `profileService.ts`.

## Sync rules
- Full sync = initial delta (everyone) + manager lookups (5 concurrent) + store the `deltaLink` in `JobSchedule(directory.delta).cursor`.
  Delta sync resumes from the cursor and falls back to a full sync if there is none. Managers are refreshed by the (daily) full sync only.
- Writes happen only when something changed. Departments and locations are created from the Entra text on first sight.
- Disabled / ineligible / removed in the directory ⇒ `Employee.accountEnabled=false` (removed: `directoryDeletedAt`, never hard-deleted) and
  the `UserAccount` is disabled with reason `directory` and `sessionVersion` bumped. Re-enabling in the directory re-enables **only**
  accounts the sync itself disabled; an admin's manual disable is preserved.
- Objects without a GUID id are skipped.

## Eligibility [OPEN]
Default: `userType == "Member"` (a null `userType` is *not* eligible), a mail or UPN, UPN not starting with `DIRECTORY_ELIGIBILITY_EXCLUDE_UPN_PREFIXES`
(default `svc-`), and optionally `companyName == DIRECTORY_ELIGIBILITY_COMPANY_NAME`. Group-based eligibility is not implemented.

## API
- `GET /api/directory/employees?q=&limit=` — permission `directory.search` (submitter+). `q` ≥ 2 chars (400 otherwise), `limit` 1–25
  (default 10). 30 requests / minute / user via the Postgres rate limiter (429 + `Retry-After`). Local DB first (all words must match,
  prefix matches ranked first, LIKE wildcards escaped, parameterised SQL); if < 3 results and `q` ≥ 3 chars, Graph is asked, eligible
  users are upserted and the query re-run; a Graph failure never breaks search. `entraObjectId` is never returned.
- `GET /api/directory/employees/[id]` — same DTO, 404 for unknown/ineligible.
- `GET /api/me/profile` — own profile; refreshes from Graph when older than 24 h (failure non-fatal); missing fields are `null`.

## Rate limiter
`src/platform/rateLimit/dbRateLimit.ts` is now a real fixed-window limiter backed by `RateLimitBucket` (one atomic upsert; verified:
100 concurrent checks admit exactly `limit`). Phase 11 will apply it more broadly.

## Verification status
Unit + integration tests pass (including search over 2,000 employees, and the trigram index being usable: 2.8 ms bitmap scan vs
20 ms seq scan on 20,000 rows; the planner picks a seq scan at small sizes, which is fine).
**Not verified against real Microsoft Graph**: no daemon app registration exists [EXTERNAL]. Response shapes, `$search` syntax,
delta behaviour (e.g. whether `accountEnabled` is returned in delta pages) and `Retry-After` handling are implemented from the
documented API and tested with mocks only.
The sync is not scheduled yet; the job runner arrives in Phase 8 (`DIRECTORY_SYNC_ENABLED` is read there).
