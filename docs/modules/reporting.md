# Dashboards and reporting (Phase 10)

## Who sees what
| Surface | Permission | Scope |
|---|---|---|
| `/my/tickets` summary tiles, `GET /api/reports/my` | `dashboard.own` (everyone) | the person's own tickets (requester or creator): open, waiting for their reply, resolved-to-confirm, closed in the last 30 days |
| `/desk/dashboard`, `GET /api/reports/summary` | `reports.team` (agent+) | **agent: team scope** (tickets assigned to them, or in their groups, plus the unassigned queue when they are in a triage group). **manager/admin: all tickets.** |
| `/admin/reports`, `GET /api/reports/export.csv` | `reports.all` (manager+) | all tickets |

Team scope deliberately does **not** include tickets an agent merely raised as a requester. An agent who asks for a group they are not in gets 403. Archived
tickets are excluded everywhere. Scope is enforced in SQL (`reportScopeSql`), and a parity test checks it against an independent rule.

## Numbers (all computed in Postgres, never summed in application memory)
- **Open** = new, assigned, in progress, on hold. By status / priority / group, backlog age buckets (`< 1`, `1-3`, `3-7`, `7-14`, `> 14` days) and oldest open ticket.
- **Created vs resolved per day**: every UTC day in the range, zero days included.
- **Time to resolve / first response**: average and median (`percentile_cont`) in wall-clock minutes, over tickets resolved (or first answered) in the period.
- **Resolution SLA met**: tickets resolved in the period that have a due date, share resolved on or before it. **Response SLA met**: tickets created in the
  period with a response due date that were answered in time; tickets still unanswered count only once already overdue.
- **Past SLA, still open**: open, not paused, resolution due passed or first response due passed and unanswered.
- **Per agent**: resolved count and median time by `resolvedByEmployeeId` (the actual resolver, not the current assignee).
- `[OPEN]` Days are **UTC** days; a company time zone can replace this. Durations are wall-clock, not business minutes.

Range: `from`/`to` are inclusive `YYYY-MM-DD`, default the last 30 days, at most 366 days; malformed or reversed ranges are a 400.
Correctness is checked against a hand-computed 11-ticket fixture (`tests/integration/reports.test.ts`).

## CSV export
`GET /api/reports/export.csv?from&to&groupId&status` — managers and admins, rate limited to 5 per minute, one `report.export` audit entry per download
(row count and filters, never the data). Streamed in keyset pages of 1,000 by ticket number; **50,000 rows maximum**, refused up front with 422
`EXPORT_TOO_LARGE` (narrow the period); the generator also stops at the cap if data grew after the count.
- UTF-8 with BOM (opens correctly in Excel), CRLF, RFC 4180 quoting. Headers: `text/csv`, `attachment`, `nosniff`, `private, no-store`.
- **Formula injection**: any text cell starting (after whitespace/control characters) with `=`, `+`, `-` or `@`, or a tab/CR, is prefixed with `'`. Tested end to
  end with hostile subjects, group, assignee and requester names; the file still parses to the same number of columns.
- Columns are fixed (`EXPORT_COLUMNS`): no description, no e-mail addresses, no internal notes.

## Charts
Dependency-free inline SVG/HTML rendered on the server (`src/ui/reports/Charts.tsx`). Each chart has a text alternative (a "Show the numbers" table or printed values),
and colour is never the only signal (dashed vs solid lines, labelled values).

## Not in this phase
Saved reports, scheduled report e-mails, drill-through from a chart to the ticket list, and a company time zone.
