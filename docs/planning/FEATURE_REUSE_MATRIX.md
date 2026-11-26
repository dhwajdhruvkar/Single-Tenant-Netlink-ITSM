# Document B — FEATURE_REUSE_MATRIX.md
Source: `dhwajdhruvkar/ticket-management-integration` @ `8cfb3eb` (read-only). Paths are relative to that repo.

Legend:
- **Reuse:** copy with only mechanical edits (imports, removing `tenantId`).
- **Adapt:** keep the logic and restructure it.
- **Rewrite:** re-implement, using the original only as a behavioural reference.
- **Remove:** do not bring it into the new repo.

Launch classes:
- **L** — required for initial launch.
- **R2** — required after launch.
- **F** — optional future capability.
- **X** — excluded.

## 1. Module classification and reuse decisions

| Module | Current implementation (actual source) | Decision | Launch | Reason | Dependencies |
|---|---|---|---|---|---|
| Multi-tenancy (Tenant model, tenant switching, `currentTenantId`, `x-tenant`) | `prisma/schema.prisma` `Tenant` + `tenantId` FK on ~25 models; `src/server/context.ts`; `src/server/data/index.ts#defaultTenantId` | **Remove** | X | [CONFIRMED] single company. Departments, groups and locations replace it; they are not tenants | — |
| Organisation onboarding / deletion | `services/organizationService.ts`, `api/v1/organizations/*`, migrations `phase15_org_onboarding`, `verified_organization_deletion` | **Remove** | X | SaaS onboarding is out of scope | — |
| Local password accounts, invitations, account setup | `auth/passwords.ts`, `services/accountAccessService.ts`, `UserInvitation`, `app/setup-account`, `api/v1/account/*`, `api/v1/users/[id]/access-link` | **Remove** | X | [CONFIRMED] no local passwords or self-registration | — |
| Demo / public-demo sign-in, persona switcher, impersonation | `auth.ts` Credentials "demo", `shared/publicDemoUsers.ts`, `components/Persona.tsx`, `x-actor`/`x-impersonate` in `context.ts`, `DEMO_MODE` | **Remove** | X | [CONFIRMED] no demo credentials. Impersonation contradicts "agent must not impersonate requester" | — |
| In-memory / JSON data store and seed | `data/memoryStore.ts`, `data/seed.ts` (1,182 lines), `data/kbArticles.data.ts`, `DATA_DRIVER` | **Remove** | X | Dual persistence doubles testing and hides SQL problems. Use Postgres in Docker for dev and tests | Docker |
| Generic `DataStore`/`Collection<T>` port | `data/store.ts`, `data/prismaStore.ts` (shallow-equality filters, in-memory filtering in services) | **Rewrite** | L | Replace with per-module Prisma repositories and typed queries; keep the *ideas* of `updateIf` (CAS) and `pageCollection` | Prisma |
| Raw-SQL ticket search | `data/ticketSql.ts` (Prisma.sql builders for explorer views, counts, workloads) | **Adapt** | L | Parameterised SQL is good. Drop `tenantId`, re-target the new columns, and add the access-policy predicate | Phase 7 |
| Entra sign-in | `auth.ts` (MicrosoftEntraID provider, email-based provisioning, `externalId=providerAccountId`), `auth.config.ts`, `proxy.ts` | **Rewrite** | L | Key must be the `oid` claim; add `tid` check, app-role sync and per-request account status check. Keep the edge/node split pattern and the `authorized` callback idea | Phase 3 |
| RBAC matrix | `server/auth/rbac.ts` (`can(role, perm)`), `shared/rbac.ts` | **Adapt** | L | The pattern is right. Roles change (no tenant_admin/super_admin) and permissions are refined (Doc C §3) | Phase 3 |
| Route guards | `server/guards.ts` (`requirePermission`), `server/http.ts` (`ok/fail/paginated/parsePagination/readJson`) | **Adapt** | L | Good, small helpers. Drop API-key/tenant branches and add request-id and error mapping | Phase 1 |
| API keys & external integration API | `auth/apiKeys.ts`, `api/v1/api-keys/*`, `integrationWebhookService.ts`, `WebhookDelivery`, `openapi*` | **Remove** (keep for reference) | F | No confirmed external system. Re-add only on request | — |
| Requester search | `services/requesterSearch.ts` (loads all users, filters in memory), `api/v1/requesters`, `components/RequesterPicker.tsx` | **Rewrite** backend; **Adapt** UI | L | Needs a directory-backed indexed search with a Graph fallback. The picker's UX (debounce, keyboard nav) is reusable | Phase 4 |
| User lookup by email | `services/userLookup.ts` | **Remove** | — | Email is not the identity key | — |
| Microsoft Graph token | `integrations/graphToken.ts` (client-credentials, cache, in-flight dedupe, tenant-id validation) | **Reuse** | L | Solid and dependency-free. Drop per-organisation credential maps | Phase 4 |
| Graph email intake & send | `channels/graphEmail.ts` (poll inbox, mark read), `channels/emailIngest.ts`, `emailThreading.ts`, `emailText.ts`, `EmailMessage` | **Adapt** | R2 (send: L) | `sendMail` is needed for notifications at launch. Inbound intake waits for a [OPEN] mailbox decision. Threading and loop/spam guards are valuable | Phase 9 / 15 |
| Brevo, Slack, Zendesk, Freshdesk, generic webhooks | `channels/brevoEmail.ts`, `slack.ts`, `webhookAdapters.ts`, `api/webhooks/*` | **Remove** | X | Not company systems. Microsoft-only | — |
| Teams | `channels/teams.ts` (incoming webhook post + bot text endpoint), `integrations/teamsPresence.ts` (Graph presence) | **Adapt** (notifier), **Remove** (presence, bot) | R2 / F | O365 connectors are being retired, so use the Workflows webhook adapter. Presence needs `Presence.Read.All` and is not required | Phase 15 |
| Ticket model & lifecycle | `services/ticketService.ts`, `services/workflowService.ts`, `shared/workflow.ts`, `domain/models.ts`, `TicketStatus` (11 states incl. `auto_resolved`, `pending_agent`) | **Rewrite** (using as reference) | L | Need `createdBy`, requester FK, a simpler state machine, a version column, and one creation service for both forms | Phase 5/7 |
| Intake pipeline | `services/intake.ts` (classification, SLA, routing, automations, AI triage) | **Adapt** | L (no AI) | Keep ordering: validate → priority → SLA → route → persist → notify. Drop AI/automations at launch | Phase 5 |
| Priority matrix | `domain/priority.ts` (`derivePriority(impact, urgency)`), `shared/priority.ts`, `components/PriorityPreview.tsx` | **Reuse** | L | Pure functions with tests (`tests/priority.test.ts`). Confirm the matrix with IT [OPEN] | — |
| Ticket types & type details | `shared/ticketTypes.ts` (`checkTypeDetails`, `sanitizeTypeDetails`), `components/TicketTypeFields.tsx` | **Adapt** | L | Good server-side sanitising. Types narrow to incident and service_request at launch | Phase 5 |
| Issue context / screenshot notes | `shared/issueContext.ts`, `components/ScreenshotUploader.tsx`, `lib/screenshotUploads.ts` | **Adapt** | L | The uploader UX is reusable through the new attachments API | Phase 6 |
| Ticket references | `domain/ids.ts` `ticketReference()` → random `INC-9F2A1C` | **Rewrite** | L | Random 24-bit refs can collide. Use a DB sequence | Phase 5 |
| Idempotency | `services/idempotencyService.ts` (scope/request hash) | **Adapt** | L | Simplify to an `Idempotency-Key` header unique per creator | Phase 5 |
| Conversation & internal notes | `TicketMessage` (authorKind, visibility), `components/ConversationThread.tsx`, `RequesterReplyBox.tsx`, `api/v1/tickets/[id]/messages`, `tests/ticketMessageValidation.test.ts` | **Adapt** | L | The visibility model is right. Add `authorEmployeeId` FK and keep the "internal hidden from requester" default-deny | Phase 7 |
| Ticket explorer / views / filters | `components/TicketsExplorer.tsx` (2,101 lines), `lib/ticketViews.ts`, `lib/ticketFilters.ts`, `lib/explorerPaging.ts` | **Adapt** (split) | L | Valuable views and filters logic, but the component is too large. Split into list, filters and saved views | Phase 7 |
| Ticket detail / properties | `app/tickets/[id]/page.tsx`, `components/TicketProperties.tsx`, `TicketComposer.tsx` | **Adapt** | L | `TicketComposer` derives the requester name from the email (`split("@")`), so use the requester snapshot instead | Phase 7 |
| Employee portal | `app/portal/page.tsx` (1,442 lines; sends `requesterEmail`) | **Rewrite** UI using parts | L | Form B must not send the requester at all; split into small components | Phase 5B |
| Assignment groups & routing | `services/groupService.ts` (`memberIds String[]`, `categories[]`, round-robin, `reassignToLeastLoaded`, `routeTicketToGroup`) | **Adapt** | L | Algorithms are reusable. Replace arrays with a membership join table and category→group mapping | Phase 8 |
| Triage / dispatch | `services/triageService.ts`, `components/TriageView.tsx`, `api/v1/triage/*` | **Adapt** | L | The unassigned queue for the service-desk group is needed | Phase 7 |
| Routing recommendation | `services/routingRecommendation.ts` (similar-case heuristics) | **Defer** | F | Nice to have; not core | — |
| SLA engine | `services/slaService.ts` (policies, business calendar walker, pause on pending), `BusinessCalendar`, `tests/sla.test.ts`, `slaPause.test.ts` | **Reuse** core calculator, **Adapt** persistence | L | The calendar walker and pause logic are proven by tests. Holidays become rows | Phase 8 |
| Escalation & workflow monitoring | `services/workflowMonitoring.ts`, `jobs/workflowMaintenance.ts`, `workflowBoard.ts`, `WorkflowAlerts.tsx`, staged manager/RM escalation | **Adapt** subset | R2 | SLA-breach escalation to the group lead or manager is useful. Staged "RM" escalation is company workflow to confirm [OPEN] | Phase 8 / 15 |
| Resolution acknowledgement | `services/ticketAcknowledgement.ts`, `notify/acknowledgementTokens.ts`, `/ticket-confirmation` | **Adapt** | R2 | Optional "confirm resolution" email links. At launch, employees confirm in the app | Phase 15 |
| Jobs: scheduler & locks | `jobs/scheduler.ts` (`setInterval`), `jobs/lock.ts` (session advisory lock), `jobs/durableLease.ts` (row lease), `JobLease` | **Rewrite** scheduler, **Reuse** lease idea | L | `setInterval` is not serverless-safe, and advisory session locks break under transaction pooling | Phase 8 |
| Notification outbox | `notify/workflowOutbox.ts`, `NotificationDelivery`, `notify/notifier.ts`, `notify/templates.ts` | **Adapt** | L | The outbox pattern is right. Generalise to the `job` table. Templates are reusable after removing tenant branding | Phase 9 |
| In-app notifications | `Notification` (keyed by `toAddress` email), `api/v1/notifications` | **Adapt** | L | Key on `recipientEmployeeId` | Phase 9 |
| Live updates (SSE, typing) | `events/bus.ts` (EventEmitter), `api/v1/events`, `tickets/[id]/typing`, `lib/liveEvents.ts`, `useLiveRefresh.ts` | **Remove** SSE/typing; **Adapt** `useLiveRefresh` to polling | L (polling) | Single-process only. Typing indicators are not needed | Phase 7 |
| Attachments service | `services/attachmentService.ts` (allowlist, blocked extensions, magic-byte sniffing, scan seam), `shared/attachments.ts`, `AttachmentPicker.tsx`, `AttachmentsPanel.tsx` | **Adapt** | L | Validation is valuable. Change keys to namespaced paths and add staged uploads plus sha256 | Phase 6 |
| Storage adapters | `storage/blobPort.ts`, `blobStore.ts` (selector), `databaseBlob.ts` (Postgres `AttachmentBlob`), `azureBlob.ts` (SharedKey REST, auto-creates container) | **Adapt** | L | The port is good. Allow `/` in keys, pre-provision the container (no auto-create in prod), add an S3 provider later | Phase 6 |
| Audit chain | `audit/auditChain.ts` (per-tenant hash chain, unique `[tenantId, index]`), `AuditViewer.tsx` | **Adapt** | L | Keep append-only audit. The hash chain is optional (per-row hash; global sequence contention). The viewer is reusable | Phase 5/11 |
| Soft delete | `deletedAt` on Ticket, migration `ticket_soft_delete`, `tests/softDelete.test.ts` | **Adapt** | L | Becomes `archivedAt` and `archivedBy`, manager-only | Phase 7 |
| Departments | `services/departmentService.ts`, `Department` | **Adapt** | L | Departments are synced from the Entra `department` attribute, plus admin aliases | Phase 4 |
| Availability / calendars per agent | `services/availabilityService.ts`, `calendarService.ts`, `AvailabilityPreferences.tsx` | **Defer** | F | Not required for round-robin at launch | — |
| Knowledge base | `services/kbService.ts`, `KBManager.tsx` (882 lines), `api/v1/kb/*`, `KBArticle` (embeddings) | **Adapt** (no embeddings) | R2 | Useful deflection, but not launch-critical. Use Postgres full-text search instead of vectors | Phase 15 |
| AI resolver, embeddings, LLM, vector search, screenshot analysis, translate, summary, classification endpoint | `server/ai/*`, `Resolution`, `Citation`, `prisma/sql/001_pgvector.sql`, Gemini/Groq/Azure OpenAI | **Remove** (reference only) | F [OPEN] | Requires company approval; data would leave the tenant. pgvector may be unavailable on company PG | — |
| Problem management | `services/problemService.ts`, `app/problems`, `Problem` | **Defer** | F | Valuable for mature ITSM, but not requested for launch | — |
| Change management & approvals | `services/changeService.ts`, `approvalService.ts`, `app/changes`, `Change`, `Approval` | **Adapt** | R2 [OPEN] | The CAB process is unknown. Ticket approvals (for service requests) are R2 too, unless IT says launch | Phase 15 |
| Service catalog | `ServiceRequestCatalogItem`, `api/v1/catalog` (`requiresApproval`, `formSchema`) | **Adapt** minimal | L (categories) / R2 (catalog forms) | Launch uses a category tree; the catalog with forms and approvals comes in R2 | Phase 2/15 |
| Assets / CMDB | `assetService.ts`, `Asset`, `ConfigurationItem`, `CIRelationship`, `app/assets` | **Remove** for now | F | Not requested. Intune/asset integration would be a separate project | — |
| Automations | `automationService.ts`, `AutomationRule` | **Remove** for now | F | The rules engine adds complexity; routing rules cover launch | — |
| Macros / canned responses | `macroService.ts`, `Macro` | **Adapt** | R2 | Cheap productivity win | Phase 15 |
| Custom fields | `customFieldService.ts`, `CustomFieldDef` | **Remove** for now | F | Use type details JSON; add later if needed | — |
| Metrics & analytics | `metricsService.ts`, `agentPerformance.ts`, `app/analytics` (841 lines), `AgentPerformance.tsx`, `api/v1/metrics*`, `reports/trends` | **Adapt** | L (basic) / R2 | Queries must move to SQL aggregates and drop tenant scoping | Phase 10 |
| PDF reports | `reportPdfService.ts` (pdfkit), `api/v1/reports` | **Defer** | R2 | CSV export is enough at launch. pdfkit needs output tracing config | Phase 10/15 |
| Weekly digest / monthly report jobs | `scheduler.ts#weeklyDigestSweep`, `monthlyReportSweep` | **Defer** | F | — | — |
| Ticket links / merge | `api/v1/tickets/[id]/links`, `merge` | **Adapt** | R2 | Duplicate handling is useful after launch | Phase 15 |
| Satisfaction (CSAT) | `Ticket.satisfaction` string | **Rewrite** | R2 | A proper survey table | Phase 15 |
| Profile / settings UI | `ProfileView.tsx` (1,684 lines), `SettingsView.tsx` (2,671 lines) | **Rewrite** | L (small) | Mostly tenant/account/API-key settings. The new admin UI is groups, categories, SLA, users | Phase 7/8 |
| App shell / design system | `AppShell.tsx`, `IconRail.tsx`, `TopBar.tsx`, `primitives.tsx`, `ui.tsx`, `Theme.tsx`, `Toast.tsx`, `Skeleton.tsx`, `motion.tsx`, `icons.tsx`, `globals.css` (Tailwind 4) | **Reuse/Adapt** | L | Saves UI effort. Remove the persona and tenant switcher from the TopBar | Phase 1 |
| Legal pages | `app/legal/*` (public SaaS privacy/AUP) | **Remove** | X | Company policies live on the intranet; link instead [OPEN] | — |
| Rate limiting | `rateLimit.ts` (in-memory), `sharedRateLimit.ts` + `PublicRateLimit` (DB) | **Adapt** DB version | L | Multi-instance safe | Phase 1/11 |
| Client IP / proxy trust | `clientIp.ts` (`TRUST_PROXY_HEADERS`, Vercel detection) | **Reuse** | L | Needed for company reverse proxy later | Phase 1 |
| Logger | `observability/logger.ts` (JSON) | **Reuse** | L | Platform-neutral stdout JSON | Phase 1 |
| Resilience helpers | `resilience.ts` (timeouts/retries) | **Reuse** | L | For Graph calls | Phase 4 |
| Config | `server/config.ts` (feature detection, demo/auth modes) | **Rewrite** | L | Zod-validated env with no demo modes | Phase 1 |
| Production env/security checks | `scripts/check-production-environment.cjs` (requires `*.neon.tech`), `check-production-security.cjs` | **Rewrite** | L | Must be provider-neutral | Phase 1/13 |
| Security headers | `next.config.mjs` headers | **Reuse/Adapt** | L | Tighten CSP | Phase 1/11 |
| Dockerfile / compose | multi-stage standalone, pgvector compose | **Adapt** | L (dev) / Phase 16 | Use plain `postgres:<company version>`; add a worker entrypoint | Phase 0/16 |
| CI | `.github/workflows/ci.yml` (typecheck, lint, test, audit, build) | **Adapt** | L | Add a Postgres service for integration tests and a migration drift check. Drop `agent-tools:check` | Phase 0 |
| Prisma migrations | 8 migrations under `prisma/migrations` | **Remove** | — | The new schema starts from a fresh baseline migration. Never copy old migration history | Phase 2 |
| Tests | 70 Vitest files under `tests/` | **Adapt selectively** | L | Port the pure-logic tests: priority, sla, slaPause, ticketTypes, ticketFilters, ticketViews, explorerPaging, emailText, emailThreading, graphTokenAndClientIp, graphTokenConcurrency, attachments (validation), webhookSecurity (if reused), pagination, ticketMessageValidation. Tenant/demo/org tests are dropped | Each phase |
| Agent tooling | `.agents/`, `.claude/`, `agent-tools.lock.json`, `requirements-agent-tools.txt`, graphify/archify scripts, `AGENTS.md` | **Remove** | X | Not application code. Write a fresh, short `CLAUDE.md`/`AGENTS.md` for the new repo | Phase 0 |
| Docs / tasks / manual testing xlsx | `docs/`, `tasks/`, `docs/manual-testing/*.xlsx` | **Remove** | X | Refer to them in the original repo as needed | — |
| Vercel config | `vercel.json`, `.vercelignore`, `.vercel` (ignored) | **Rewrite** | L | New project; the cron definition is new | Phase 13 |
| Env templates | `.env.example`, `.env.production.example` | **Rewrite** | L | New contract (Doc D §4) | Phase 0 |

## 2. Code that is reusable without modification (mechanical import changes only)

- `src/server/domain/priority.ts`, `src/shared/priority.ts`
- `src/server/integrations/graphToken.ts` (single credential set)
- `src/server/observability/logger.ts`, `src/server/resilience.ts`, `src/server/clientIp.ts`
- The pure business-calendar functions in `src/server/services/slaService.ts` (`addCalendarMinutes` and the walker)
- The `sniffImageType` / extension / MIME allowlist parts of `attachmentService.ts`
- `src/server/channels/emailText.ts` (HTML→text) for Release 2 intake
- UI primitives: `primitives.tsx`, `ui.tsx`, `Skeleton.tsx`, `Toast.tsx`, `icons.tsx`, `InfoHint.tsx`, `useNarrow.ts`

## 3. Code that needs adaptation

`http.ts`, `guards.ts`, `rbac.ts`, `ticketSql.ts`, `groupService.ts`, `workflowOutbox.ts`, `notifier.ts`, `templates.ts`, `auditChain.ts`, `blobPort.ts`, `databaseBlob.ts`, `azureBlob.ts`, `ticketTypes.ts`, `issueContext.ts`, `intake.ts`, `metricsService.ts`, `agentPerformance.ts`, `RequesterPicker.tsx`, `TicketsExplorer.tsx`, `ConversationThread.tsx`, `AttachmentPicker.tsx`, `AppShell.tsx`/`TopBar.tsx`, `next.config.mjs`, `Dockerfile`, `ci.yml`.

## 4. Code to rewrite

`auth.ts`/`auth.config.ts`/`proxy.ts` (identity), `context.ts` (Actor), `config.ts`, `data/*` (repositories), `ticketService.ts` (create + lifecycle), `requesterSearch.ts`, `scheduler.ts`, `ids.ts#ticketReference`, `portal/page.tsx`, `SettingsView.tsx`, `ProfileView.tsx`, env-check scripts.

## 5. Must not be moved to the new repository

`.git/`, `.vercel/`, any `.env*` file other than examples, `.data/`, `node_modules/`, `.next/`, `prisma/migrations/**`, `prisma/seed.ts`, `src/server/data/seed.ts`, `kbArticles.data.ts`, `.agents/`, `.claude/`, `tasks/`, `docs/`, `graphify-out/`, `.archify/`, all tenant/org/demo/password/API-key code listed above, and Brevo/Slack/Zendesk/Freshdesk adapters.
