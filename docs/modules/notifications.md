# Notifications and email (Phase 9)

## Flow
Domain changes write `notify.*` jobs in the same transaction as the change (Phases 5, 7, 8). `modules/notifications/dispatcher.ts` consumes them:
1. A dispatch job works out the recipients, then — in one transaction — inserts **one in-app `Notification` per recipient** and **one `notify.email` job per
   recipient who should get mail**.
2. The `notify.email` job renders the email from the stored notification and sends it through the `MailSender` port.

Splitting email into its own job means a mail outage retries with backoff **without re-creating notifications**.

## Exactly once
In-app rows carry `Notification.dedupeKey = {dispatch job key}:{recipient}` (migration `0003_notification_dedupe`, unique) and email jobs use
`email:{key}:{recipient}`; both are inserted with ON CONFLICT DO NOTHING. A dispatch job that is retried, re-run after a crash, or run by several runners at once
adds nothing (tested with 3 concurrent dispatches). Email delivery itself is **at-least-once**: if a send succeeds but the job cannot be marked done, the retry sends it again.

## Who is told what (launch rules)
| Event | Recipients | Email |
|---|---|---|
| created | requester ("we received…"); if someone else logged it also the creator ("logged for Jane") and the requester gets "logged on your behalf" | yes |
| assigned | the assignee, unless they did it themselves; with nobody assigned, the group's agents | assignee yes; group notice **in-app only** |
| public reply | the other party: an agent's reply → requester (+ creator); the requester's reply → assignee, else the group's agents (in-app only). Never the author | yes (except the group fallback) |
| **internal note** | agents only (assignee, else group agents), never the requester, **text never copied** into the notification or job | **never** |
| resolved | requester (+ creator), with confirm/reopen wording and a link | yes |
| on hold, awaiting requester | requester (+ creator). Other hold reasons: nobody | yes |
| reopened | assignee, else group agents | yes / in-app |
| auto-closed | requester. A requester's own confirmation or cancellation: nobody (their own action) | yes |
| cancelled by someone else | requester (+ creator) | yes |
| SLA warning | assignee + group leads | yes |
| SLA breach | assignee + group leads; a resolve breach (`escalate`) also **all managers** ([OPEN] default; no automatic reassignment) | yes |
| priority change | nobody at launch (handler exists so the jobs are consumed) | — |
Recipients must be enabled, eligible, present in the directory; managers/leads must have an active account. Links go to `/desk/…` for agents and `/my/…`
for everyone else (including people who have never signed in). Notifications for tickets that are already finished or archived are skipped.

## Preferences [OPEN]
"Email me" defaults to **on**. Only `UserAccount.preferences.emailNotifications === false` turns it off (in-app is unaffected). There is no UI for the preference yet.
People with neither `mail` nor a UPN that looks like an address get in-app notifications only.

## Email
- Port `MailSender`; `EMAIL_PROVIDER=noop` (default) logs only the recipient *domain* and the subject *length*; `graph` posts to
  `/users/{SUPPORT_MAILBOX}/sendMail` with the app-only token (`saveToSentItems: false`); **`smtp` is not implemented** (optional, [OPEN]) and makes
  email jobs fail loudly rather than drop mail. `EMAIL_PROVIDER=graph` is validated at startup (mailbox + Graph credentials).
- **[EXTERNAL]** Graph needs the application permission `Mail.Send`, which must be restricted to the support mailbox by company IT (Exchange RBAC for
  Applications / Application Access Policy). Without that restriction the permission could send as any mailbox. This has **not** been exercised against real Graph.
- Rendering (`templates.ts`): plain inline-styled HTML + text alternative, no remote images/scripts. Every user-supplied value is HTML-escaped; subjects are
  single-line (CR/LF, control characters and Unicode line separators removed) so ticket text cannot inject markup or mail headers. Links are built from
  `APP_BASE_URL`. The subject carries the reference (`[INC…]`) when the title lacks it.
- A recipient who left, was disabled or opted out between queueing and sending is skipped at send time.
- The Graph client gained `POST` (with the same timeout and 429/503 `Retry-After` handling); the sender validates the mailbox and recipient addresses.

## In-app
`GET /api/notifications?limit=&unread=1` → `{data, meta:{unread}}` and `POST /api/notifications/read` (`{ids}` or `{all:true}`). Everything is scoped to
the caller; ids that belong to someone else are silently ignored. The header bell polls every 60 s while the tab is visible, shows the last known list with
a message if a refresh fails, and renders nothing when signed out.

## Deviations / notes
- The dispatcher also consumes `notify.ticket_priority_changed` as a deliberate no-op.
- Payloads of the assignment jobs now include `actorEmployeeId` so nobody is told about their own action; jobs queued by older code simply lack it.
- Malformed ids in a job payload are ignored (a bug found by a test: they used to make Prisma throw and the job retry until dead).

## Verification
Unit: templates (escaping, header-injection, snapshots, every kind), Graph sender payload/validation/retry, noop logging, config validation, inbox contract.
Integration (real Postgres): the full recipient matrix, exactly-once (retry, concurrent runners), preferences/addressability, email job (links, escaping, skipping
disabled/opted-out), retry with backoff → recovery, persistent outage → dead job without duplicates or loss, noop provider, an end-to-end run through the real
services and the runner, inbox scoping. Component tests for the bell. HTTP on the production build: create → cron → inboxes, internal-note isolation, no
duplicates on re-run, inbox API scoping and validation.
**Not verified:** any real email (Graph or otherwise), Exchange scoping, rendering in real mail clients, the bell in a live browser, high volume.
