# Core ticket management (Phase 7)

## Lifecycle (`stateMachine.ts`)
`new → assigned | in_progress | on_hold | resolved | cancelled`, `assigned → in_progress | on_hold | resolved | cancelled`,
`in_progress → assigned | on_hold | resolved | cancelled`, `on_hold → assigned | in_progress | resolved | cancelled`,
`resolved → in_progress (reopen) | closed`, `closed` and `cancelled` are terminal. Tested exhaustively (every from × to pair).
Who: in_progress / on_hold / resolved = agent+; resolved→closed = the requester (confirm) or agent+; reopen = the requester within
`ticket.reopenWindowDays` (default 7 [OPEN]) or agent+ any time; cancel = the requester/creator while `new`, or agent+. `assigned` is only
reachable through the assignment action (the status API answers 422 `USE_ASSIGNMENT`). Illegal moves are 409 `ILLEGAL_TRANSITION` for
everyone, admins included; a ticket you cannot see is 404.

## Concurrency
Every change carries `version`; the write is `UPDATE … WHERE id=? AND version=?`. A mismatch is 409 `STALE_VERSION`. Verified: 20
concurrent writers → one wins; two agents taking one ticket → one 200, one 409 (also over HTTP). Messages are not versioned.

## Mutations (each is one transaction: ticket + `TicketEvent` + `AuditLog` + outbox job)
- `POST /api/tickets/{ref}/status` — hold needs a reason; resolution code/notes only when resolving; reopen clears the resolution and
  counts `reopenCount`. Resolving a ticket nobody replied to counts as the first response.
- `PATCH /api/tickets/{ref}` — priority / impact / urgency / category / type (agent+). A priority override needs a reason; `priority: null`
  clears it; impact/urgency changes recompute the priority unless overridden. Changing priority or type recomputes SLA due dates from
  the creation time and re-applies the hold time already spent. Changing type clears type details; the reference never changes.
- `POST /api/tickets/{ref}/assignment` — `groupId?`, `assigneeEmployeeId?: id | "me" | null`. Agents take a ticket or assign within groups they
  belong to; managers/admins to any member of the target group; the assignee must be an active, eligible member of the resulting group (or
  of a triage group if there is none). Changing group clears an assignee who is not in the new group. `new ⇄ assigned` follows the assignee.
- `POST /api/tickets/{ref}/messages` — see below. `POST /api/tickets/{ref}/archive` — manager+, soft delete.

## Conversation and visibility
- Internal notes need agent+ (employee ⇒ 403). They are excluded **in the database queries** for non-agents: messages, their attachments,
  the `internal_note_added` events and agent-written free-text reasons never reach the response. Asserted on the raw JSON in integration tests
  and over HTTP. The notification job for a note carries `visibility: internal` and never the body.
- The first public agent reply (by someone other than the requester) sets `firstRespondedAt`.
- A reply by the requester/creator on a hold `awaiting_requester` returns the ticket to `in_progress` and resumes the SLA; an agent reply does not.
- Closed/cancelled tickets accept no messages (409). Messages are plain text (rendering escapes it). Attachments are linked in the same
  transaction; someone else's staged file rolls the message back.

## SLA pause (`sla/pause.ts`) — deviates from the reference implementation
Entering a pausing hold stamps `slaPausedAt`; leaving it credits the **business minutes** in the policy's calendar and pushes the due dates by
that many business minutes. The reference shifted by wall-clock time, which would credit a whole weekend to a business-hours ticket. Which
hold reasons pause the clock is the [OPEN] setting `sla.pauseHoldReasons` (default `["awaiting_requester"]`). `sla/status.ts` derives the
SLA level from timestamps on read (no job needed).

## Lists (`list.ts`, `GET /api/tickets`)
Views: `mine` (default; requested or created by me), `assigned`, `groups`, `unassigned` (the **triage** queue: untaken tickets with no group
or in a triage group, for triage members; everyone with view-all sees all untaken), `all` (view-all roles; agents only with the [OPEN]
`AGENTS_VIEW_ALL_TICKETS`), `breaching` (open, running tickets whose deadline is past or within 2 h — the window is a constant, [OPEN]),
`visible` (agent+: everything they may see). Access (`visibleTicketsWhere`) is part of every query; rows are never filtered in memory.
Employees get 403 for queue views and people filters. Filters: status, priority, type, group, assignee, category, requester, created range,
text. Pagination `page/pageSize` (≤ 100) with a true total; sort by createdAt / updatedAt / priority / resolveDueAt.
**Search:** every term is a *prefix* match (`vpn` finds `VPNLIKE`), all terms must match, over reference + subject + description
(Postgres full-text, `simple` config). A reference matches exactly. Only alphanumeric tokens reach the tsquery (no operator injection). It is
two-step (matching ids, capped at 2,000, then the access-filtered query), so a search with more than 2,000 matches is truncated.

## UI
`/desk` (queue tabs, search, status/priority/sort filters, paging), `/desk/tickets/{ref}` (detail, conversation, composer with internal-note
toggle, action panel), `/my/tickets` and `/my/tickets/{ref}` (own tickets; reply, confirm, reopen, cancel with confirmation). Pages poll
every 30 s while visible (`useLivePolling`; no SSE). The UI only mirrors `actions` computed by the server; the API re-checks everything.
On a 409 the user is told someone else changed the ticket and the page reloads.

## Other deviations / decisions
- New permission `ticket.update` (agent+) for working a ticket (in_progress/on_hold/field edits).
- The Phase 5 minimal ticket summary view was removed (superseded).
- Messages cannot be edited or deleted yet (no endpoint; removed messages render as "removed").
- Notification jobs are enqueued but nothing consumes them until Phases 8–9.

## Verification
Unit: state machine table (all 49 pairs + role rules), pause arithmetic, calendar minutes. Integration (real Postgres): lifecycle, optimistic
concurrency races, assignment rules, field updates and SLA recompute, pause/resume, archive, conversation and leak tests, role × queue
matrix, filters, search (incl. injection), pagination/sort. Component tests for the composer and action panels. HTTP acceptance run on the
production build (queues per role, 403/404/409/400 cases, raw-JSON leak checks, race, archive, page access).
**Not verified:** a real browser (focus management, layout, polling in a live tab); behaviour with several app instances behind a proxy;
list/search performance at tens of thousands of tickets (no EXPLAIN/load run yet — Phase 11).
