# Ticket creation (Phase 5A)

One service, `createTicket(deps, actor, command)` (`src/modules/tickets/createTicket.ts`), behind two thin endpoints (≈ 25 lines each, no
business rules). They differ only in how the requester is resolved.

| | `POST /api/tickets/self` (Form B) | `POST /api/tickets/assisted` (Form A) |
|---|---|---|
| Permission | `ticket.create.self` (everyone) | `ticket.create.assisted` (submitter+) |
| Requester | always the signed-in actor | `requesterEmployeeId` only; re-read from the DB |
| Channel | `portal` | `phone | walk_in | email | teams | chat` |
| Agent-only fields | none (any extra key ⇒ 400) | `priorityOverride`, `assignmentGroupId`, `assigneeEmployeeId` — agent+ only (403 otherwise) |
| Rate limit | 10 / min / user | 30 / min / user |
| Response | 201 `{data:{id,reference}}`; 200 + `Idempotency-Replayed: true` on replay | same |

Errors: 400 validation (with field paths, strict schema), 401, 403, 409 idempotency key reused with a different body, 422
`REQUESTER_NOT_ELIGIBLE | CATEGORY_INVALID | GROUP_INVALID | ASSIGNEE_NOT_IN_GROUP`, 429.

## Rules implemented
- Requester snapshots (name, email, department, job title, location) are read from the database, never from the client. Snapshot
  email is `mail`, falling back to the UPN when mail is empty. A `locationNote` overrides only the ticket's location snapshot.
- Priority = impact × urgency matrix → `p1..p4` (the original 5-level matrix collapsed: low + very_low → p4; P5 is [OPEN]). Defaults:
  category default impact/urgency, else medium/medium. An override needs agent+ and a reason, and is recorded
  (`priorityOverridden`, reason, and the derived priority in the `created` event).
- Routing: explicit group (agent+) → category default group (if active) → triage group → none. An assignee must be an active, eligible
  member of the target group; an assigned ticket starts as `assigned`, otherwise `new`.
- SLA: the active policy for (priority, type) — type-specific beats all-types — gives `responseDueAt`/`resolveDueAt` from the creation
  time, through the policy's business calendar (minute-resolution window, ISO weekdays, holidays, DST-aware) or 24×7 when no calendar
  is set. **No policy ⇒ no due dates**; targets are [OPEN] and never invented.
- Idempotency: `Idempotency-Key` (8–128 of `[A-Za-z0-9._:-]`), unique per creator. The request hash is stored in the `created` event's
  data, so reuse with a different body is a 409. Concurrent requests with the same key create exactly one ticket.
- One transaction writes: ticket (+ sequence-backed reference), one `created` TicketEvent, one `ticket.create` AuditLog row and the
  outbox jobs `notify.ticket_created` / `notify.ticket_assigned` (dedupe keys `{ticketId}:created|assigned`). A failure in any of
  them rolls back all of them. The audit `changes` never contain the description or any secret.
- `attachmentIds` is accepted by the contract but a non-empty list is rejected until Phase 6.

## Deviations
- Permission names are `ticket.create.self` / `ticket.create.assisted` (Doc C naming), not `ticket.create.on_behalf` (Doc D).
- `stateMachine.ts` and `access.ts` from the Phase 5A file list were not created: there is nothing to put in them yet (state machine →
  Phase 7; access policy already lives in `modules/identity/policies.ts`).
- The rate limiter counts every request to the endpoint, including rejected ones.

## Verification
Unit (priority matrix ×9, calendar arithmetic incl. weekends/holidays/DST, strict contracts, type details) and integration tests
(107 total) pass, including 50 parallel creates ⇒ 50 unique references, concurrent same-key ⇒ one ticket, and audit-failure rollback.
The two endpoints were also exercised over HTTP on the production build with minted session cookies (create, spoof attempts, 403/422,
replay/409, cross-site 403, 429).
