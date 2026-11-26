# Ticket forms (Phases 5B and 5C)

## Form B: employee self-service — `/my/tickets/new`
- Server component loads the signed-in person's directory profile (`getOwnProfile`) and passes it to `NewTicketForm`.
- `RequesterCard` is display-only (text, no controls) and shows "Not provided in directory" for missing values.
- **The request body contains no requester information.** `buildSelfPayload` is an allow-list; unit and component tests assert that no
  `requester*`, `createdBy`, `role` or `channel` key and none of the profile's values are ever sent, and that the body passes the strict
  server contract.
- Impact/urgency come from two plain-language questions ("How many people are affected?", "Can you still work?") mapped to
  low/medium/high (idea from the original portal's `affectedPeople`/`workStopped`; the three-way "work" answer is new). Service requests
  send neither, so the server defaults apply.
- `useCreateTicket`: one `Idempotency-Key` per form mount; double submits are ignored; the key is kept after a network error/5xx (a
  retry is safe) and replaced after a 4xx (the body is about to change). Server field errors appear in an `role="alert"` summary that
  receives focus; fields carry `aria-invalid`/`aria-describedby`.
- On success: redirect to `/my/tickets/{reference}?created=1` (a status banner; no toast library was added).

## Form A: agent-assisted — `/desk/tickets/new`
- Page-level role check (`ticket.create.assisted`): an employee gets a "no access" page, and the API independently returns 403.
- `EmployeeSearch`: ARIA combobox, 250 ms debounce, ≥ 2 characters, Up/Down (wrapping)/Enter/Escape, stale responses discarded,
  department · title · office on each option, explicit messages for no results / 429 / 403 / failures.
- Only `requesterEmployeeId` identifies the requester; name/email/department are re-read and snapshotted by the server. Choosing a
  different employee replaces the card. "Created by: <agent>" is read-only.
- `AgentOnlyFields`: channel (all roles that can use the form), and — for agent+ only — priority override (with reason), group, and an
  assignee list filtered to the group's members. Submitters do not see those controls (the server also rejects them with 403).
- "Recent tickets for this employee" (last 5) uses `GET /api/tickets?requesterEmployeeId=` (agent+). It is restricted to tickets the
  caller may see; a slow lookup for a previously selected person is discarded.

## Access to tickets
- `visibleTicketsWhere(actor)` is the SQL form of `canViewTicket`; an integration test proves they agree for every role ×
  relationship × triage membership × agents-view-all setting. Lists/searches must use it.
- A ticket a person may not see is a **404**, never a 403.
- `/my/tickets` (minimal list) and `/my/tickets/{ref}`, `/desk/tickets/{ref}` (minimal read-only view) exist so the forms have somewhere to
  land; the full list, detail page, lifecycle and conversation are Phase 7.

## Not done / caveats
- No attachments yet (Phase 6). The categories dropdown is empty until categories exist (the seed adds one placeholder).
- Component tests run under jsdom; **no real-browser test** (Playwright E2E is Phase 14), so layout, focus rings and real screen-reader
  behaviour are unverified. The accessibility checks are limited to labels, roles, focus on the error summary and keyboard operation.
- Component tests run in the default `npm test` (`tests/component`, jsdom via a per-file docblock).
