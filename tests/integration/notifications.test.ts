import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHandlers } from "@/modules/jobs/handlers";
import type { ClaimedJob, HandlerRegistry } from "@/modules/jobs/runner";
import { runDueJobs } from "@/modules/jobs/runner";
import { buildNotificationHandlers } from "@/modules/notifications/dispatcher";
import { listNotifications, markRead } from "@/modules/notifications/inbox";
import type { MailSender, OutboundEmail } from "@/modules/notifications/ports";
import { assignTicket } from "@/modules/tickets/assign";
import { changeStatus } from "@/modules/tickets/changeStatus";
import { createTicket } from "@/modules/tickets/createTicket";
import { addMessage } from "@/modules/tickets/messages";
import { fixedClock } from "@/platform/clock";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const BASE = "https://itsm.example.test/";
const sent: OutboundEmail[] = [];
const mailer = (fail?: () => boolean): MailSender => ({ provider: "noop", send: async (m) => { if (fail?.()) throw new Error("graph 503"); sent.push(m); } });
beforeEach(() => { sent.length = 0; });

const handlers = (mail: MailSender = mailer()): HandlerRegistry => buildNotificationHandlers({ db: prisma, mail: () => mail, appBaseUrl: BASE });
let jobSeq = 0;
const job = (kind: string, payload: object, dedupeKey: string | null = `${kind}:k${++jobSeq}`): ClaimedJob => ({ id: `00000000-0000-4000-8000-${String(jobSeq).padStart(12, "0")}`, kind, payload, attempts: 1, maxAttempts: 8, dedupeKey });
const dispatch = async (h: HandlerRegistry, kind: string, payload: object, key?: string | null) => { const j = job(kind, payload, key); await h[kind](j); return j; };

const inapp = async (...who: { employeeId: string }[]) => {
  const rows = await prisma.notification.findMany({ orderBy: { createdAt: "asc" } });
  return Object.fromEntries(who.map((w) => [w.employeeId, rows.filter((r) => r.recipientEmployeeId === w.employeeId)]));
};
const emailJobs = () => prisma.job.findMany({ where: { kind: "notify.email" }, orderBy: { createdAt: "asc" } });

async function scene() {
  const g = await W.group("Desk");
  const requester = await W.actor("employee", [], { displayName: "Rita Requester", mail: "rita@example.test" });
  const agent = await W.actor("agent", [g], { displayName: "Alan Agent", mail: "alan@example.test" });
  const other = await W.actor("agent", [g], { displayName: "Beth Agent", mail: "beth@example.test" });
  const lead = await W.actor("agent", [], { displayName: "Lena Lead", mail: "lena@example.test" });
  await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: lead.employeeId, role: "lead" } });
  const manager = await W.actor("manager", [], { displayName: "Mia Manager", mail: "mia@example.test" });
  const t = await W.ticket({ requester, group: g.id, subject: "VPN keeps dropping" });
  return { g, requester, agent, other, lead, manager, t };
}

describe("created", () => {
  it("self-service: one in-app notification and one email job, for the requester only", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id, recipientEmployeeId: s.requester.employeeId });
    const n = await inapp(s.requester, s.agent);
    expect(n[s.requester.employeeId]).toHaveLength(1);
    expect(n[s.requester.employeeId][0]).toMatchObject({ type: "ticket_created", title: `We received your ticket ${s.t.reference}`, link: `/my/tickets/${s.t.reference}` });
    expect(n[s.agent.employeeId]).toHaveLength(0);
    expect(await emailJobs()).toHaveLength(1);
  });

  it("logged by an agent for someone: the requester hears it was logged for them, the agent gets 'logged for Rita'", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, createdBy: s.agent, group: s.g.id });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: t.id });
    const n = await inapp(s.requester, s.agent);
    expect(n[s.requester.employeeId][0]).toMatchObject({ type: "ticket_logged_on_behalf" });
    expect(n[s.requester.employeeId][0].body).toContain("Alan Agent");
    // (the title uses the ticket's stored requester-name snapshot, which the test helper sets to "Requester")
    expect(n[s.agent.employeeId][0]).toMatchObject({ type: "ticket_logged_for", title: `Ticket ${t.reference} logged for Requester`, link: `/desk/tickets/${t.reference}` });
    expect(await emailJobs()).toHaveLength(2);
  });
});

describe("assigned", () => {
  it("tells the assignee (email + in-app), not the person who did the assigning", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: (await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "assigned" })).id, assigneeEmployeeId: s.agent.employeeId, actorEmployeeId: s.other.employeeId });
    expect((await inapp(s.agent, s.other))[s.agent.employeeId]).toHaveLength(1);
    expect((await inapp(s.other))[s.other.employeeId]).toHaveLength(0);
    expect(await emailJobs()).toHaveLength(1);
  });

  it("self-assignment notifies nobody", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "assigned" });
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: t.id, assigneeEmployeeId: s.agent.employeeId, actorEmployeeId: s.agent.employeeId });
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("with no assignee, the group's agents get an in-app notice and NO email", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: s.t.id, assignmentGroupId: s.g.id, assigneeEmployeeId: null, actorEmployeeId: s.requester.employeeId });
    const n = await inapp(s.agent, s.other, s.lead, s.requester);
    expect(n[s.agent.employeeId][0].type).toBe("ticket_group_new");
    expect(n[s.other.employeeId]).toHaveLength(1);
    expect(n[s.lead.employeeId]).toHaveLength(1);
    expect(n[s.requester.employeeId]).toHaveLength(0);
    expect(await emailJobs()).toHaveLength(0);
  });

  it("skips group members who are disabled, ineligible, removed from the directory or not agents", async () => {
    const s = await scene();
    for (const over of [{ accountEnabled: false }, { isEligible: false }, { directoryDeletedAt: new Date() }]) await W.actor("agent", [{ id: s.g.id }], over);
    await W.actor("employee", [{ id: s.g.id }]);
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: s.t.id, assignmentGroupId: s.g.id, assigneeEmployeeId: null });
    expect(await prisma.notification.count()).toBe(3); // Alan, Beth, Lena
  });

  it("does nothing for a ticket that is already finished or archived", async () => {
    const s = await scene();
    const done = await W.ticket({ requester: s.requester, group: s.g.id, status: "closed" });
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: done.id, assignmentGroupId: s.g.id });
    const archived = await W.ticket({ requester: s.requester, group: s.g.id });
    await prisma.ticket.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await dispatch(handlers(), "notify.ticket_assigned", { ticketId: archived.id, assignmentGroupId: s.g.id });
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("public replies go to the other party", () => {
  const reply = async (s: Awaited<ReturnType<typeof scene>>, by: { employeeId: string }, kind: "agent" | "employee", body = "Have you tried restarting?", assignee?: typeof s.agent) => {
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: assignee ?? null, status: assignee ? "assigned" : "new" });
    const m = await prisma.ticketMessage.create({ data: { ticketId: t.id, authorEmployeeId: by.employeeId, authorKind: kind, visibility: "public", body } });
    await dispatch(handlers(), "notify.ticket_message", { ticketId: t.id, messageId: m.id, visibility: "public" });
    return t;
  };

  it("an agent's reply notifies the requester (email + in-app) with an excerpt, not the agent", async () => {
    const s = await scene();
    await reply(s, s.agent, "agent");
    const n = await inapp(s.requester, s.agent);
    expect(n[s.requester.employeeId]).toHaveLength(1);
    expect(n[s.requester.employeeId][0]).toMatchObject({ type: "message_public", body: "Alan Agent: Have you tried restarting?" });
    expect(n[s.agent.employeeId]).toHaveLength(0);
    expect(await emailJobs()).toHaveLength(1);
  });

  it("the requester's reply notifies the assignee; with nobody assigned, the group's agents in-app only", async () => {
    const s = await scene();
    await reply(s, s.requester, "employee", "Still broken", s.agent);
    expect((await inapp(s.agent, s.other))[s.agent.employeeId]).toHaveLength(1);
    expect((await inapp(s.other))[s.other.employeeId]).toHaveLength(0);
    expect(await emailJobs()).toHaveLength(1);
    await resetDatabase(prisma);
    const s2 = await scene();
    await reply(s2, s2.requester, "employee", "Anyone there?");
    expect(await prisma.notification.count()).toBe(3);
    expect(await emailJobs()).toHaveLength(0);
  });

  it("a long reply is excerpted to 300 characters in the notification", async () => {
    const s = await scene();
    await reply(s, s.agent, "agent", "y".repeat(2000));
    expect((await prisma.notification.findFirstOrThrow()).body.length).toBeLessThanOrEqual(320);
  });

  it("a deleted message produces nothing", async () => {
    const s = await scene();
    const m = await prisma.ticketMessage.create({ data: { ticketId: s.t.id, authorEmployeeId: s.agent.employeeId, authorKind: "agent", visibility: "public", body: "oops", deletedAt: new Date() } });
    await dispatch(handlers(), "notify.ticket_message", { ticketId: s.t.id, messageId: m.id, visibility: "public" });
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("internal notes are never emailed and never reach the requester", () => {
  it("notifies agents only, in-app only, with no body text; no email job at all", async () => {
    const s = await scene();
    const SECRET = "INTERNAL: customer is a flight risk";
    const m = await prisma.ticketMessage.create({ data: { ticketId: s.t.id, authorEmployeeId: s.agent.employeeId, authorKind: "agent", visibility: "internal", body: SECRET } });
    await dispatch(handlers(), "notify.ticket_message", { ticketId: s.t.id, messageId: m.id, visibility: "internal" });
    const rows = await prisma.notification.findMany();
    expect(rows.map((r) => r.recipientEmployeeId).sort()).toEqual([s.other.employeeId, s.lead.employeeId].sort());
    expect(rows.every((r) => r.type === "message_internal")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("flight risk");
    expect(await prisma.notification.count({ where: { recipientEmployeeId: s.requester.employeeId } })).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("with an assignee it goes to the assignee (in-app), never the requester, and still no email", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.other, status: "assigned" });
    const m = await prisma.ticketMessage.create({ data: { ticketId: t.id, authorEmployeeId: s.agent.employeeId, authorKind: "agent", visibility: "internal", body: "note" } });
    await dispatch(handlers(), "notify.ticket_message", { ticketId: t.id, messageId: m.id, visibility: "internal" });
    expect((await prisma.notification.findMany()).map((r) => r.recipientEmployeeId)).toEqual([s.other.employeeId]);
    expect(await prisma.job.count({ where: { kind: "notify.email" } })).toBe(0);
  });
});

describe("status changes", () => {
  const status = async (s: Awaited<ReturnType<typeof scene>>, ticketOver: object, payload: object) => {
    const t = await W.ticket({ requester: s.requester, group: s.g.id, ...ticketOver });
    await dispatch(handlers(), "notify.ticket_status_changed", { ticketId: t.id, ...payload });
    return t;
  };
  const recipients = async () => (await prisma.notification.findMany()).map((n) => `${n.type}:${n.recipientEmployeeId}`).sort();

  it("resolved -> requester, with the confirm/reopen wording and a link to their ticket", async () => {
    const s = await scene();
    const t = await status(s, { status: "resolved", resolvedAt: new Date() }, { from: "in_progress", to: "resolved" });
    expect(await recipients()).toEqual([`ticket_resolved:${s.requester.employeeId}`]);
    expect((await prisma.notification.findFirstOrThrow()).body).toMatch(/confirm[\s\S]*reopen/);
    expect((await prisma.notification.findFirstOrThrow()).link).toBe(`/my/tickets/${t.reference}`);
  });

  it("resolved on a ticket someone else logged -> requester AND creator", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, createdBy: s.agent, group: s.g.id, status: "resolved", resolvedAt: new Date() });
    await dispatch(handlers(), "notify.ticket_status_changed", { ticketId: t.id, from: "in_progress", to: "resolved" });
    expect((await prisma.notification.findMany()).map((n) => n.recipientEmployeeId).sort()).toEqual([s.requester.employeeId, s.agent.employeeId].sort());
  });

  it("on hold awaiting the requester -> requester; any other hold reason -> nobody", async () => {
    const s = await scene();
    await status(s, { status: "on_hold", holdReason: "awaiting_requester" }, { from: "in_progress", to: "on_hold" });
    expect(await recipients()).toEqual([`ticket_awaiting_requester:${s.requester.employeeId}`]);
    await resetDatabase(prisma);
    const s2 = await scene();
    await status(s2, { status: "on_hold", holdReason: "awaiting_vendor" }, { from: "in_progress", to: "on_hold" });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("reopened -> the assignee (or the group's agents in-app); ordinary in_progress -> nobody", async () => {
    const s = await scene();
    await status(s, { status: "in_progress", assignee: s.agent }, { from: "resolved", to: "in_progress" });
    expect(await recipients()).toEqual([`ticket_reopened:${s.agent.employeeId}`]);
    await resetDatabase(prisma);
    const s2 = await scene();
    await status(s2, { status: "in_progress", assignee: s2.agent }, { from: "assigned", to: "in_progress" });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("auto-closed -> requester; a requester's own confirmation (closed, not auto) -> nobody", async () => {
    const s = await scene();
    await status(s, { status: "closed" }, { from: "resolved", to: "closed", auto: true });
    expect(await recipients()).toEqual([`ticket_closed:${s.requester.employeeId}`]);
    await resetDatabase(prisma);
    const s2 = await scene();
    await status(s2, { status: "closed" }, { from: "resolved", to: "closed" });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("cancelled by an agent -> requester is told; cancelled by the requester -> not told about their own action", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, status: "cancelled" });
    await prisma.ticketEvent.create({ data: { ticketId: t.id, type: "status_changed", actorEmployeeId: s.agent.employeeId, fromValue: "new", toValue: "cancelled" } });
    await dispatch(handlers(), "notify.ticket_status_changed", { ticketId: t.id, from: "new", to: "cancelled" });
    expect(await recipients()).toEqual([`ticket_cancelled:${s.requester.employeeId}`]);
    await resetDatabase(prisma);
    const s2 = await scene();
    const t2 = await W.ticket({ requester: s2.requester, group: s2.g.id, status: "cancelled" });
    await prisma.ticketEvent.create({ data: { ticketId: t2.id, type: "status_changed", actorEmployeeId: s2.requester.employeeId, fromValue: "new", toValue: "cancelled" } });
    await dispatch(handlers(), "notify.ticket_status_changed", { ticketId: t2.id, from: "new", to: "cancelled" });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("priority changes are consumed without notifying anyone (not a launch event)", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_priority_changed", { ticketId: s.t.id, from: "p3", to: "p1" });
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("SLA warnings and breaches", () => {
  const people = async () => (await prisma.notification.findMany({ orderBy: { createdAt: "asc" } })).map((n) => [n.type, n.recipientEmployeeId] as const);

  it("a warning goes to the assignee and the group lead (email + in-app), not to other agents or the requester", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "in_progress" });
    await dispatch(handlers(), "notify.sla_warning", { ticketId: t.id, kind: "resolve" });
    expect((await people()).map((p) => p[1]).sort()).toEqual([s.agent.employeeId, s.lead.employeeId].sort());
    expect(await emailJobs()).toHaveLength(2);
    expect((await prisma.notification.findFirstOrThrow()).body).toContain("resolve");
  });

  it("a breach goes to the assignee and lead; an escalating (resolve) breach also reaches managers, with no duplicates", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "in_progress" });
    await dispatch(handlers(), "notify.sla_breached", { ticketId: t.id, kind: "response", escalate: false });
    expect((await people()).map((p) => p[0])).toEqual(["sla_breached", "sla_breached"]);
    await resetDatabase(prisma);
    const s2 = await scene();
    // the manager is ALSO the lead here: they must be told once, as a lead
    await prisma.userAccount.update({ where: { id: s2.manager.userAccountId }, data: {} });
    await prisma.assignmentGroupMember.create({ data: { groupId: s2.g.id, employeeId: s2.manager.employeeId, role: "lead" } });
    const t2 = await W.ticket({ requester: s2.requester, group: s2.g.id, assignee: s2.agent, status: "in_progress" });
    await dispatch(handlers(), "notify.sla_breached", { ticketId: t2.id, kind: "resolve", escalate: true });
    const rows = await prisma.notification.findMany();
    expect(rows.filter((r) => r.recipientEmployeeId === s2.manager.employeeId)).toHaveLength(1);
    expect(rows.map((r) => r.recipientEmployeeId).sort()).toEqual([s2.agent.employeeId, s2.lead.employeeId, s2.manager.employeeId].sort());
  });

  it("an escalation reaches managers who are not in the group, labelled as an escalation", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "in_progress" });
    await dispatch(handlers(), "notify.sla_breached", { ticketId: t.id, kind: "resolve", escalate: true });
    const mgr = await prisma.notification.findFirstOrThrow({ where: { recipientEmployeeId: s.manager.employeeId } });
    expect(mgr).toMatchObject({ type: "sla_escalation", title: `Escalation: ${t.reference} breached its SLA` });
    expect(await prisma.notification.count({ where: { recipientEmployeeId: s.requester.employeeId } })).toBe(0);
  });

  it("skips tickets that were resolved, closed or cancelled in the meantime", async () => {
    const s = await scene();
    for (const status of ["resolved", "closed", "cancelled"]) {
      const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status });
      await dispatch(handlers(), "notify.sla_breached", { ticketId: t.id, kind: "resolve", escalate: true });
      await dispatch(handlers(), "notify.sla_warning", { ticketId: t.id, kind: "resolve" });
    }
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("exactly once", () => {
  it("running the same dispatch job twice (a retry after a crash) creates no duplicates", async () => {
    const s = await scene();
    const h = handlers();
    const j = job("notify.ticket_created", { ticketId: s.t.id }, "ticket-created-key-1");
    await h["notify.ticket_created"](j);
    await h["notify.ticket_created"](j);
    await h["notify.ticket_created"]({ ...j, attempts: 2 });
    expect(await prisma.notification.count()).toBe(1);
    expect(await emailJobs()).toHaveLength(1);
  });

  it("two runners dispatching the same job at once create one notification and one email job per recipient", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, createdBy: s.agent, group: s.g.id });
    const j = job("notify.ticket_created", { ticketId: t.id }, "concurrent-key");
    await Promise.all([handlers()["notify.ticket_created"](j), handlers()["notify.ticket_created"](j), handlers()["notify.ticket_created"](j)]);
    expect(await prisma.notification.count()).toBe(2);
    expect(await emailJobs()).toHaveLength(2);
  });

  it("different events for the same person each notify once", async () => {
    const s = await scene();
    const h = handlers();
    await dispatch(h, "notify.ticket_created", { ticketId: s.t.id });
    await dispatch(h, "notify.ticket_created", { ticketId: s.t.id });
    expect(await prisma.notification.count()).toBe(2); // two distinct events (different dedupe keys)
  });
});

describe("preferences and addressability", () => {
  it("[OPEN] email defaults to on; an explicit opt-out keeps the in-app notification but sends no email", async () => {
    const s = await scene();
    await prisma.userAccount.update({ where: { id: s.requester.userAccountId }, data: { preferences: { emailNotifications: false } } });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    expect(await prisma.notification.count()).toBe(1);
    expect(await emailJobs()).toHaveLength(0);
  });

  it("other preference values leave email on", async () => {
    const s = await scene();
    await prisma.userAccount.update({ where: { id: s.requester.userAccountId }, data: { preferences: { emailNotifications: true, theme: "dark" } } });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    expect(await emailJobs()).toHaveLength(1);
  });

  it("a person with no mail falls back to a UPN that looks like an address, and with neither gets in-app only", async () => {
    const s = await scene();
    const noMail = await W.actor("employee", [], { mail: null, userPrincipalName: "upn.user@example.test" });
    const t = await W.ticket({ requester: noMail, group: s.g.id });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: t.id });
    expect(await emailJobs()).toHaveLength(1);
    await prisma.job.deleteMany();
    const noAddr = await W.actor("employee", [], { mail: null, userPrincipalName: "just-a-username" });
    const t2 = await W.ticket({ requester: noAddr, group: s.g.id });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: t2.id });
    expect(await emailJobs()).toHaveLength(0);
    expect(await prisma.notification.count({ where: { recipientEmployeeId: noAddr.employeeId } })).toBe(1);
  });

  it("a requester who has never signed in (no account) still gets the in-app notice and email, linked to 'my tickets'", async () => {
    const s = await scene();
    const ghost = await W.person({ displayName: "Never Signed In", mail: "ghost@example.test" });
    const t = await prisma.ticket.create({ data: { number: BigInt(990001), reference: "INC0990001", type: "incident", channel: "phone", subject: "Phone call", description: "d", impact: "medium", urgency: "medium", priority: "p3", requesterName: "Never Signed In", requesterEmployeeId: ghost.id, createdByEmployeeId: s.agent.employeeId, assignmentGroupId: s.g.id } });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: t.id });
    expect((await prisma.notification.findFirstOrThrow({ where: { recipientEmployeeId: ghost.id } })).link).toBe("/my/tickets/INC0990001");
    expect(await emailJobs()).toHaveLength(2);
  });

  it("people who are disabled, ineligible or removed from the directory get nothing", async () => {
    const s = await scene();
    for (const over of [{ accountEnabled: false }, { isEligible: false }, { directoryDeletedAt: new Date() }]) {
      const gone = await W.actor("employee", [], over);
      const t = await W.ticket({ requester: gone, group: s.g.id });
      await dispatch(handlers(), "notify.ticket_created", { ticketId: t.id });
    }
    expect(await prisma.notification.count()).toBe(0);
  });

  it("an account disabled by an admin is treated as a plain employee for the link (and still reachable by email)", async () => {
    const s = await scene();
    await prisma.userAccount.update({ where: { id: s.agent.userAccountId }, data: { status: "disabled" } });
    const t = await W.ticket({ requester: s.agent, group: s.g.id });
    await dispatch(handlers(), "notify.ticket_created", { ticketId: t.id });
    expect((await prisma.notification.findFirstOrThrow()).link).toBe(`/my/tickets/${t.reference}`);
  });

  it("a missing ticket or malformed payload is ignored, not an error", async () => {
    const h = handlers();
    for (const payload of [{}, { ticketId: 42 }, { ticketId: "00000000-0000-4000-8000-000000000000" }]) {
      await expect(h["notify.ticket_created"](job("notify.ticket_created", payload))).resolves.toBeUndefined();
    }
    await expect(h["notify.ticket_message"](job("notify.ticket_message", { ticketId: "x" }))).resolves.toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe("notify.email", () => {
  const send = async (s: Awaited<ReturnType<typeof scene>>, mail = mailer()) => {
    const h = handlers(mail);
    await dispatch(h, "notify.ticket_created", { ticketId: s.t.id });
    const e = await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } });
    return { h, e };
  };

  it("renders and sends the notification to the recipient, with an absolute link built from APP_BASE_URL (no double slash)", async () => {
    const s = await scene();
    const { h, e } = await send(s);
    await h["notify.email"](job("notify.email", e.payload as object));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("rita@example.test");
    expect(sent[0].subject).toBe(`We received your ticket ${s.t.reference}`);
    expect(sent[0].html).toContain(`href="https://itsm.example.test/my/tickets/${s.t.reference}"`);
    expect(sent[0].text).toContain(`https://itsm.example.test/my/tickets/${s.t.reference}`);
  });

  it("agents get a link to the desk", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, assignee: s.agent, status: "assigned" });
    const h = handlers();
    await dispatch(h, "notify.ticket_assigned", { ticketId: t.id, assigneeEmployeeId: s.agent.employeeId });
    const e = await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } });
    await h["notify.email"](job("notify.email", e.payload as object));
    expect(sent[0].html).toContain(`/desk/tickets/${t.reference}`);
  });

  it("a ticket subject with <script> is escaped in the HTML and cannot add headers to the subject line", async () => {
    const s = await scene();
    const t = await W.ticket({ requester: s.requester, group: s.g.id, subject: 'Pwn <script>alert(1)</script>\r\nBcc: evil@evil.example' });
    const h = handlers();
    await dispatch(h, "notify.ticket_created", { ticketId: t.id });
    await h["notify.email"](job("notify.email", (await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } })).payload as object));
    expect(sent[0].html).not.toMatch(/<script/i);
    expect(sent[0].html).toContain("&lt;script&gt;");
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
    expect(sent[0].text).not.toMatch(/Bcc: evil[\s\S]*\nBcc/);
  });

  it("does not send if the person was disabled, removed or opted out after the job was queued", async () => {
    const s = await scene();
    const { h, e } = await send(s);
    await prisma.employee.update({ where: { id: s.requester.employeeId }, data: { accountEnabled: false } });
    await h["notify.email"](job("notify.email", e.payload as object));
    await prisma.employee.update({ where: { id: s.requester.employeeId }, data: { accountEnabled: true } });
    await prisma.userAccount.update({ where: { id: s.requester.userAccountId }, data: { preferences: { emailNotifications: false } } });
    await h["notify.email"](job("notify.email", e.payload as object));
    expect(sent).toHaveLength(0);
  });

  it("an unknown notification key is ignored", async () => {
    await expect(handlers()["notify.email"](job("notify.email", { notificationKey: "nope" }))).resolves.toBeUndefined();
    await expect(handlers()["notify.email"](job("notify.email", {}))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("never carries an internal note's text into an email job payload or a sent email", async () => {
    const s = await scene();
    await changeStatus({ db: prisma }, s.agent, (await W.ticket({ requester: s.requester, group: s.g.id })).reference, { version: 0, to: "in_progress" }).catch(() => undefined);
    const t = await W.ticket({ requester: s.requester, group: s.g.id });
    await addMessage({ db: prisma }, s.agent, t.reference, { body: "SECRET internal text", visibility: "internal", attachmentIds: [] });
    await addMessage({ db: prisma }, s.agent, t.reference, { body: "Public reply text", visibility: "public", attachmentIds: [] });
    const r = await runDueJobs({ db: prisma, handlers: buildHandlers({ db: prisma, storage: () => { throw new Error("n/a"); }, directory: () => null, mail: () => mailer(), appBaseUrl: BASE }), owner: "t", clock: fixedClock(new Date(Date.now() + 1000)), maxJobs: 100 });
    expect(r.dead).toBe(0);
    expect(JSON.stringify(await prisma.job.findMany())).not.toContain("SECRET internal");
    expect(JSON.stringify(sent)).not.toContain("SECRET internal");
    expect(JSON.stringify(sent)).toContain("Public reply text");
  });
});

describe("retries and the noop provider", () => {
  const emailRunner = (mail: MailSender, at: Date) => runDueJobs({ db: prisma, handlers: { "notify.email": buildNotificationHandlers({ db: prisma, mail: () => mail, appBaseUrl: BASE })["notify.email"] }, owner: "r", clock: fixedClock(at), maxJobs: 50 });

  it("a mail failure is retried with backoff, creates no duplicate notification, and succeeds once the provider recovers", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    let down = true;
    const mail = mailer(() => down);
    const t0 = new Date(Date.now() + 1000);
    expect(await emailRunner(mail, t0)).toMatchObject({ retried: 1, succeeded: 0 });
    const queued = await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } });
    expect(queued).toMatchObject({ status: "queued", attempts: 1, lastError: "graph 503" });
    expect(queued.runAfter.getTime()).toBe(t0.getTime() + 60_000);
    expect((await emailRunner(mail, new Date(t0.getTime() + 1000))).claimed).toBe(0); // backoff not elapsed
    down = false;
    expect(await emailRunner(mail, new Date(t0.getTime() + 61_000))).toMatchObject({ succeeded: 1 });
    expect(sent).toHaveLength(1);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("a persistent outage ends in a dead job (visible), never in lost or duplicated notifications", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    await prisma.job.updateMany({ where: { kind: "notify.email" }, data: { maxAttempts: 2 } });
    const mail = mailer(() => true);
    let at = Date.now() + 1000;
    for (let i = 0; i < 4; i++) { await emailRunner(mail, new Date(at)); at += 2 * 3_600_000; }
    expect(await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } })).toMatchObject({ status: "dead", attempts: 2, lastError: "graph 503" });
    expect(await prisma.notification.count()).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("EMAIL_PROVIDER=noop does not break any flow: jobs succeed and the in-app notifications are there", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    const { NoopMailSender } = await import("@/modules/notifications/providers/noopMailSender");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await emailRunner(new NoopMailSender(), new Date(Date.now() + 1000))).toMatchObject({ succeeded: 1, dead: 0 });
    expect(await prisma.notification.count()).toBe(1);
  });

  it("an unusable provider (smtp) fails the email job loudly instead of silently dropping mail, but not the in-app notification", async () => {
    const s = await scene();
    await dispatch(handlers(), "notify.ticket_created", { ticketId: s.t.id });
    const broken: () => MailSender = () => { throw new Error("EMAIL_PROVIDER=smtp is not implemented."); };
    const h = buildNotificationHandlers({ db: prisma, mail: broken, appBaseUrl: BASE });
    const r = await runDueJobs({ db: prisma, handlers: { "notify.email": h["notify.email"] }, owner: "r", clock: fixedClock(new Date(Date.now() + 1000)) });
    expect(r.retried).toBe(1);
    expect((await prisma.job.findFirstOrThrow({ where: { kind: "notify.email" } })).lastError).toMatch(/not implemented/);
    expect(await prisma.notification.count()).toBe(1);
  });
});

describe("end to end through the real services and the runner", () => {
  it("create, assign, reply, resolve: each event produces one notification per recipient, drained by the runner", async () => {
    const g = await prisma.assignmentGroup.create({ data: { name: "Service Desk", isTriage: true } });
    const requester = await W.actor("employee", [], { displayName: "Rita", mail: "rita@example.test" });
    const agent = await W.actor("agent", [{ id: g.id }], { displayName: "Alan", mail: "alan@example.test" });
    const run = () => runDueJobs({ db: prisma, handlers: buildHandlers({ db: prisma, storage: () => { throw new Error("n/a"); }, directory: () => null, mail: () => mailer(), appBaseUrl: BASE }), owner: "e2e", maxJobs: 200, clock: fixedClock(new Date(Date.now() + 5000)) });

    const { ticket } = await createTicket({ db: prisma }, requester, { type: "incident", subject: "Laptop dead", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal" });
    await run();
    expect((await listNotifications(prisma, requester, { limit: 10, unreadOnly: false })).data.map((n) => n.type)).toEqual(["ticket_created"]);
    expect((await listNotifications(prisma, agent, { limit: 10, unreadOnly: false })).data.map((n) => n.type)).toEqual(["ticket_group_new"]); // triage agent, in-app only

    await assignTicket({ db: prisma }, agent, ticket.reference, { version: 0, assigneeEmployeeId: "me" });
    await addMessage({ db: prisma }, agent, ticket.reference, { body: "Looking now", visibility: "public", attachmentIds: [] });
    await addMessage({ db: prisma }, requester, ticket.reference, { body: "Thanks", visibility: "public", attachmentIds: [] });
    await changeStatus({ db: prisma }, agent, ticket.reference, { version: 1, to: "resolved", resolutionNotes: "Replaced" });
    const r = await run();
    expect(r.dead).toBe(0);

    const rita = (await listNotifications(prisma, requester, { limit: 20, unreadOnly: false })).data.map((n) => n.type).sort();
    const alan = (await listNotifications(prisma, agent, { limit: 20, unreadOnly: false })).data.map((n) => n.type).sort();
    expect(rita).toEqual(["message_public", "ticket_created", "ticket_resolved"]);
    expect(alan).toEqual(["message_public", "ticket_group_new"]); // not told about their own assignment, reply or resolution
    expect(sent.map((m) => m.to).sort()).toEqual(["alan@example.test", "rita@example.test", "rita@example.test", "rita@example.test"]);
    expect(await prisma.job.count({ where: { status: "dead" } })).toBe(0);
    expect(await prisma.job.count({ where: { kind: { startsWith: "notify." }, status: { not: "succeeded" } } })).toBe(0);
  });
});

describe("inbox", () => {
  async function inbox() {
    const s = await scene();
    const mk = (who: { employeeId: string }, title: string, over: object = {}) => prisma.notification.create({ data: { recipientEmployeeId: who.employeeId, type: "x", title, body: "b", ...over } });
    const a1 = await mk(s.requester, "first");
    await new Promise((r) => setTimeout(r, 5));
    const a2 = await mk(s.requester, "second");
    const b1 = await mk(s.agent, "not yours");
    return { s, a1, a2, b1 };
  }

  it("lists only the caller's own notifications, newest first, with the unread count", async () => {
    const { s } = await inbox();
    const r = await listNotifications(prisma, s.requester, { limit: 10, unreadOnly: false });
    expect(r.data.map((n) => n.title)).toEqual(["second", "first"]);
    expect(r.unread).toBe(2);
    expect(JSON.stringify(r)).not.toContain("not yours");
  });

  it("honours limit and unread-only, and the unread count is independent of the limit", async () => {
    const { s, a1 } = await inbox();
    await prisma.notification.update({ where: { id: a1.id }, data: { readAt: new Date() } });
    expect((await listNotifications(prisma, s.requester, { limit: 1, unreadOnly: false })).data).toHaveLength(1);
    const unread = await listNotifications(prisma, s.requester, { limit: 10, unreadOnly: true });
    expect(unread.data.map((n) => n.title)).toEqual(["second"]);
    expect(unread.unread).toBe(1);
  });

  it("marks specific notifications read, and ignores ids that belong to somebody else", async () => {
    const { s, a1, a2, b1 } = await inbox();
    expect(await markRead(prisma, s.requester, { ids: [a1.id, b1.id] })).toEqual({ updated: 1 });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: a1.id } })).readAt).not.toBeNull();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: a2.id } })).readAt).toBeNull();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: b1.id } })).readAt).toBeNull(); // untouched
  });

  it("'all' marks only the caller's own, and is idempotent", async () => {
    const { s, b1 } = await inbox();
    expect(await markRead(prisma, s.requester, { all: true })).toEqual({ updated: 2 });
    expect(await markRead(prisma, s.requester, { all: true })).toEqual({ updated: 0 });
    expect((await listNotifications(prisma, s.requester, { limit: 10, unreadOnly: false })).unread).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: b1.id } })).readAt).toBeNull();
  });
});
