import type { PrismaClient } from "@prisma/client";
import { isGuid } from "@/modules/identity/claims";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import type { ClaimedJob, HandlerRegistry } from "@/modules/jobs/runner";
import { logger } from "@/platform/logging/logger";
import type { MailSender } from "./ports";
import { areaFor, groupAgentIds, loadPeople, managerIds, type Person } from "./recipients";
import { excerpt, notificationContent, renderEmail, type ContentCtx, type NotificationKind } from "./templates";

// Turns domain events (the notify.* outbox jobs written in the same transaction as the change) into in-app notifications and email jobs.
//
//  * Exactly one in-app Notification per recipient per event, and at most one email job per recipient per event: both are keyed
//    `{event job}:{recipient}` and inserted with ON CONFLICT DO NOTHING, so a retried or re-run dispatch job adds nothing.
//  * Internal notes are never emailed, and their text is never copied into a notification.
//  * Email is a separate job, so a mail outage retries with backoff without re-creating notifications.

export interface DispatcherDeps {
  db: PrismaClient;
  mail: () => MailSender;
  appBaseUrl: string;
}

const FINAL = ["resolved", "closed", "cancelled"];

interface TicketCtx {
  id: string;
  reference: string;
  subject: string;
  status: string;
  holdReason: string | null;
  requesterEmployeeId: string;
  requesterName: string;
  createdByEmployeeId: string;
  assigneeEmployeeId: string | null;
  assignmentGroupId: string | null;
}

async function loadTicket(db: PrismaClient, ticketId: unknown): Promise<TicketCtx | null> {
  if (!isGuid(ticketId)) return null; // a malformed id is ignored; it must not make Prisma throw and the job retry forever
  const t = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, reference: true, subject: true, status: true, holdReason: true, requesterEmployeeId: true, requesterName: true, createdByEmployeeId: true, assigneeEmployeeId: true, assignmentGroupId: true, archivedAt: true },
  });
  return t && !t.archivedAt ? t : null;
}

interface Target {
  person: Person;
  kind: NotificationKind;
  /** false for group-wide "new ticket in your group" style notices: in-app only */
  email: boolean;
}

/** Persist the notifications and enqueue the email jobs, atomically and idempotently. Returns how many in-app rows are new. */
async function deliver(deps: DispatcherDeps, jobKey: string, t: TicketCtx, targets: Target[], ctx: Omit<ContentCtx, "reference" | "subject">): Promise<number> {
  const seen = new Set<string>();
  const unique = targets.filter((x) => (seen.has(x.person.employeeId) ? false : (seen.add(x.person.employeeId), true)));
  if (unique.length === 0) return 0;

  return deps.db.$transaction(async (tx) => {
    const rows = unique.map((x) => {
      const content = notificationContent(x.kind, { ...ctx, reference: t.reference, subject: t.subject });
      return {
        recipientEmployeeId: x.person.employeeId, type: x.kind, title: content.title, body: content.body,
        link: `/${areaFor(x.person.role) === "desk" ? "desk" : "my"}/tickets/${t.reference}`, ticketId: t.id, dedupeKey: `${jobKey}:${x.person.employeeId}`,
      };
    });
    const created = await tx.notification.createMany({ data: rows, skipDuplicates: true });
    await enqueueJobs(
      tx,
      unique
        .filter((x) => x.email && x.person.email && x.person.emailOptIn)
        .map((x) => ({ kind: "notify.email", dedupeKey: `email:${jobKey}:${x.person.employeeId}`, payload: { notificationKey: `${jobKey}:${x.person.employeeId}` } })),
    );
    return created.count;
  });
}

const keyOf = (job: ClaimedJob) => job.dedupeKey ?? `job:${job.id}`;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function buildNotificationHandlers(deps: DispatcherDeps): HandlerRegistry {
  const { db } = deps;

  /** assignee (email + in-app), or - with nobody assigned - the group's agents (in-app only). */
  async function workers(t: TicketCtx, kindAssignee: NotificationKind, kindGroup: NotificationKind, exclude: Set<string>): Promise<Target[]> {
    if (t.assigneeEmployeeId) {
      const people = await loadPeople(db, [t.assigneeEmployeeId]);
      return people.filter((p) => !exclude.has(p.employeeId)).map((person) => ({ person, kind: kindAssignee, email: true }));
    }
    if (!t.assignmentGroupId) return [];
    const people = await loadPeople(db, await groupAgentIds(db, t.assignmentGroupId));
    return people.filter((p) => !exclude.has(p.employeeId)).map((person) => ({ person, kind: kindGroup, email: false }));
  }

  /** the requester, plus the creator when someone else filed it on their behalf */
  async function requesterSide(t: TicketCtx, kindRequester: NotificationKind, kindCreator: NotificationKind | null, exclude = new Set<string>()): Promise<Target[]> {
    const people = await loadPeople(db, [t.requesterEmployeeId, kindCreator ? t.createdByEmployeeId : null]);
    return people
      .filter((p) => !exclude.has(p.employeeId))
      .map((person) => ({ person, kind: person.employeeId === t.requesterEmployeeId ? kindRequester : (kindCreator as NotificationKind), email: true }));
  }

  return {
    "notify.ticket_created": async (job) => {
      const t = await loadTicket(db, (job.payload as { ticketId?: unknown }).ticketId);
      if (!t) return;
      const onBehalf = t.createdByEmployeeId !== t.requesterEmployeeId;
      const actor = onBehalf ? (await loadPeople(db, [t.createdByEmployeeId]))[0] : undefined;
      const targets = await requesterSide(t, onBehalf ? "ticket_logged_on_behalf" : "ticket_created", onBehalf ? "ticket_logged_for" : null);
      await deliver(deps, keyOf(job), t, targets, { requesterName: t.requesterName, actorName: actor?.displayName });
    },

    "notify.ticket_assigned": async (job) => {
      const p = job.payload as { ticketId?: unknown; actorEmployeeId?: unknown };
      const t = await loadTicket(db, p.ticketId);
      if (!t || FINAL.includes(t.status)) return;
      const exclude = new Set([str(p.actorEmployeeId)].filter((x): x is string => x !== null)); // nobody is told about their own action
      await deliver(deps, keyOf(job), t, await workers(t, "ticket_assigned", "ticket_group_new", exclude), { requesterName: t.requesterName });
    },

    "notify.ticket_status_changed": async (job) => {
      const p = job.payload as { ticketId?: unknown; from?: unknown; to?: unknown };
      const t = await loadTicket(db, p.ticketId);
      if (!t) return;
      const to = str(p.to);
      const from = str(p.from);
      let targets: Target[] = [];
      if (to === "resolved") targets = await requesterSide(t, "ticket_resolved", "ticket_resolved");
      else if (to === "on_hold" && t.holdReason === "awaiting_requester") targets = await requesterSide(t, "ticket_awaiting_requester", "ticket_awaiting_requester");
      else if (to === "in_progress" && from === "resolved") targets = await workers(t, "ticket_reopened", "ticket_reopened", new Set());
      else if (to === "closed" && (job.payload as { auto?: unknown }).auto === true) targets = await requesterSide(t, "ticket_closed", null);
      else if (to === "cancelled") {
        const last = await db.ticketEvent.findFirst({ where: { ticketId: t.id, type: "status_changed", toValue: "cancelled" }, orderBy: { createdAt: "desc" }, select: { actorEmployeeId: true } });
        targets = await requesterSide(t, "ticket_cancelled", "ticket_cancelled", new Set(last?.actorEmployeeId ? [last.actorEmployeeId] : []));
      }
      if (targets.length) await deliver(deps, keyOf(job), t, targets, {});
    },

    "notify.ticket_message": async (job) => {
      const p = job.payload as { ticketId?: unknown; messageId?: unknown; visibility?: unknown };
      const t = await loadTicket(db, p.ticketId);
      const messageId = str(p.messageId);
      if (!t || !isGuid(messageId)) return;
      const m = await db.ticketMessage.findUnique({ where: { id: messageId }, select: { authorEmployeeId: true, authorKind: true, visibility: true, body: true, deletedAt: true } });
      if (!m || m.deletedAt) return;
      const author = m.authorEmployeeId ? (await loadPeople(db, [m.authorEmployeeId]))[0] : undefined;
      const exclude = new Set(m.authorEmployeeId ? [m.authorEmployeeId] : []);

      if (m.visibility === "internal") {
        // Agents only, in-app only (never email), and the note's text is not included.
        const targets = (await workers(t, "message_internal", "message_internal", exclude)).map((x) => ({ ...x, email: false }));
        await deliver(deps, keyOf(job), t, targets, { actorName: author?.displayName });
        return;
      }
      const targets = m.authorKind === "agent" ? await requesterSide(t, "message_public", "message_public", exclude) : await workers(t, "message_public", "message_public", exclude);
      await deliver(deps, keyOf(job), t, targets, { actorName: author?.displayName, messageExcerpt: excerpt(m.body) });
    },

    // Priority changes are not notified at launch; the handler exists so these jobs are consumed rather than piling up.
    "notify.ticket_priority_changed": async () => undefined,

    "notify.sla_warning": async (job) => {
      const p = job.payload as { ticketId?: unknown; kind?: unknown };
      const t = await loadTicket(db, p.ticketId);
      if (!t || FINAL.includes(t.status)) return;
      const kind = p.kind === "response" ? "response" : "resolve";
      const ids = [t.assigneeEmployeeId, ...(t.assignmentGroupId ? await groupAgentIds(db, t.assignmentGroupId, true) : [])];
      const targets = (await loadPeople(db, ids)).map((person) => ({ person, kind: "sla_warning" as const, email: true }));
      await deliver(deps, keyOf(job), t, targets, { slaKind: kind });
    },

    "notify.sla_breached": async (job) => {
      const p = job.payload as { ticketId?: unknown; kind?: unknown; escalate?: unknown };
      const t = await loadTicket(db, p.ticketId);
      if (!t || FINAL.includes(t.status)) return;
      const kind = p.kind === "response" ? "response" : "resolve";
      const lead = await loadPeople(db, [t.assigneeEmployeeId, ...(t.assignmentGroupId ? await groupAgentIds(db, t.assignmentGroupId, true) : [])]);
      const targets: Target[] = lead.map((person) => ({ person, kind: "sla_breached", email: true }));
      if (p.escalate === true) {
        // [OPEN] default escalation: also tell the managers. There is no automatic reassignment.
        const have = new Set(lead.map((x) => x.employeeId));
        for (const person of await loadPeople(db, await managerIds(db))) if (!have.has(person.employeeId)) targets.push({ person, kind: "sla_escalation", email: true });
      }
      await deliver(deps, keyOf(job), t, targets, { slaKind: kind });
    },

    "notify.email": async (job) => {
      const key = str((job.payload as { notificationKey?: unknown }).notificationKey);
      if (!key) return;
      const n = await db.notification.findUnique({ where: { dedupeKey: key }, select: { title: true, body: true, link: true, ticketId: true, recipientEmployeeId: true } });
      if (!n) return;
      const [person] = await loadPeople(db, [n.recipientEmployeeId]);
      if (!person?.email || !person.emailOptIn) return; // left the company or opted out since the job was queued
      const ref = n.ticketId ? (await db.ticket.findUnique({ where: { id: n.ticketId }, select: { reference: true } }))?.reference : undefined;
      const base = deps.appBaseUrl.replace(/\/+$/, "");
      const mail = renderEmail({ title: n.title, body: n.body, link: n.link ? `${base}${n.link}` : null, reference: ref });
      await deps.mail().send({ to: person.email, subject: mail.subject, html: mail.html, text: mail.text });
      logger.info("email sent", { jobId: job.id });
    },
  };
}
