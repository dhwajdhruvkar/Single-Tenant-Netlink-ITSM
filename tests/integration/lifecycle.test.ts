import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { archiveTicket } from "@/modules/tickets/archive";
import { assignTicket } from "@/modules/tickets/assign";
import { changeStatus } from "@/modules/tickets/changeStatus";
import { createTicket } from "@/modules/tickets/createTicket";
import { getTicketDetail } from "@/modules/tickets/detail";
import { addMessage } from "@/modules/tickets/messages";
import { updateTicket } from "@/modules/tickets/updateTicket";
import { fixedClock } from "@/platform/clock";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
const deps = (over: object = {}) => ({ db: prisma, ...over });

beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const T0 = "2026-03-04T15:00:00Z";
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60_000);
const version = async (id: string) => (await prisma.ticket.findUniqueOrThrow({ where: { id } })).version;

describe("status transitions (service level)", () => {
  it("walks a ticket through its whole life, recording events, audit and a version per change", async () => {
    const g = await W.group("Desk");
    const emp = await W.actor("employee");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: emp, group: g.id });

    let r = await changeStatus(deps(), agent, t.reference, { version: 0, to: "in_progress" });
    expect(r).toMatchObject({ status: "in_progress", version: 1 });
    r = await changeStatus(deps(), agent, t.reference, { version: 1, to: "on_hold", holdReason: "awaiting_vendor" });
    expect(r.status).toBe("on_hold");
    r = await changeStatus(deps(), agent, t.reference, { version: 2, to: "in_progress" });
    r = await changeStatus(deps(), agent, t.reference, { version: 3, to: "resolved", resolutionCode: "fixed", resolutionNotes: "Replaced the cable." });
    const resolved = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(resolved).toMatchObject({ status: "resolved", resolutionCode: "fixed", resolutionNotes: "Replaced the cable.", resolvedByEmployeeId: agent.employeeId });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.holdReason).toBeNull();
    r = await changeStatus(deps(), emp, t.reference, { version: 4, to: "closed" }); // requester confirms
    expect(r.status).toBe("closed");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).closedAt).not.toBeNull();

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => `${e.fromValue}>${e.toValue}`)).toEqual(["new>in_progress", "in_progress>on_hold", "on_hold>in_progress", "in_progress>resolved", "resolved>closed"]);
    expect(await prisma.auditLog.count({ where: { ticketId: t.id, action: "ticket.status" } })).toBe(5);
    expect(await prisma.job.count({ where: { kind: "notify.ticket_status_changed" } })).toBe(5);
  });

  it("closed and cancelled are terminal (409), even for admins", async () => {
    const emp = await W.actor("employee");
    const admin = await W.actor("admin");
    const closed = await W.ticket({ requester: emp, status: "closed" });
    const cancelled = await W.ticket({ requester: emp, status: "cancelled" });
    for (const t of [closed, cancelled]) {
      await expect(changeStatus(deps(), admin, t.reference, { version: 0, to: "in_progress" })).rejects.toMatchObject({ status: 409, details: { code: "ILLEGAL_TRANSITION" } });
    }
  });

  it("validates hold reasons and resolution fields", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    await expect(changeStatus(deps(), agent, t.reference, { version: 0, to: "on_hold" })).rejects.toMatchObject({ status: 400 });
    await expect(changeStatus(deps(), agent, t.reference, { version: 0, to: "in_progress", holdReason: "other" })).rejects.toMatchObject({ status: 400 });
    await expect(changeStatus(deps(), agent, t.reference, { version: 0, to: "in_progress", resolutionNotes: "x" })).rejects.toMatchObject({ status: 400 });
    expect(await version(t.id)).toBe(0);
  });

  it("an employee cannot start/hold/resolve; cancel works only while new; strangers get 404", async () => {
    const g = await W.group("Desk");
    const emp = await W.actor("employee");
    const stranger = await W.actor("employee");
    const t = await W.ticket({ requester: emp, group: g.id });
    await expect(changeStatus(deps(), emp, t.reference, { version: 0, to: "resolved" })).rejects.toMatchObject({ status: 403 });
    await expect(changeStatus(deps(), stranger, t.reference, { version: 0, to: "cancelled" })).rejects.toMatchObject({ status: 404 });
    await expect(changeStatus(deps(), emp, t.reference, { version: 0, to: "cancelled", reason: "No longer needed" })).resolves.toMatchObject({ status: "cancelled" });
    const started = await W.ticket({ requester: emp, group: g.id, status: "in_progress" });
    await expect(changeStatus(deps(), emp, started.reference, { version: 0, to: "cancelled" })).rejects.toMatchObject({ status: 403 });
  });

  it("reopen: the requester within the window, not after; agents any time; counts reopens and clears the resolution", async () => {
    const g = await W.group("Desk");
    const emp = await W.actor("employee");
    const agent = await W.actor("agent", [g]);
    const fresh = await W.ticket({ requester: emp, group: g.id, status: "resolved", resolvedAt: new Date(Date.now() - 2 * 86_400_000) });
    await prisma.ticket.update({ where: { id: fresh.id }, data: { resolutionNotes: "done", resolutionCode: "fixed" } });
    await changeStatus(deps(), emp, fresh.reference, { version: 0, to: "in_progress" });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: fresh.id } })).toMatchObject({ status: "in_progress", reopenCount: 1, resolvedAt: null, resolutionNotes: null, resolutionCode: null });
    expect((await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: fresh.id } })).type).toBe("reopened");

    const old = await W.ticket({ requester: emp, group: g.id, status: "resolved", resolvedAt: new Date(Date.now() - 9 * 86_400_000) });
    await expect(changeStatus(deps(), emp, old.reference, { version: 0, to: "in_progress" })).rejects.toMatchObject({ status: 409, details: { code: "REOPEN_WINDOW_EXPIRED" } });
    await expect(changeStatus(deps(), agent, old.reference, { version: 0, to: "in_progress" })).resolves.toMatchObject({ status: "in_progress" });
  });

  it("the reopen window follows the company setting", async () => {
    const g = await W.group("Desk");
    const emp = await W.actor("employee");
    await prisma.companySetting.create({ data: { key: "ticket.reopenWindowDays", value: 14 } });
    const t = await W.ticket({ requester: emp, group: g.id, status: "resolved", resolvedAt: new Date(Date.now() - 10 * 86_400_000) });
    await expect(changeStatus(deps(), emp, t.reference, { version: 0, to: "in_progress" })).resolves.toBeDefined();
  });

  it("resolving a ticket nobody has replied to counts as the first response", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    await changeStatus(deps({ clock: fixedClock(T0) }), agent, t.reference, { version: 0, to: "resolved" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt?.toISOString()).toBe("2026-03-04T15:00:00.000Z");
  });

  it("a failed audit write rolls the whole status change back", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    const failing = async () => { throw new Error("audit down"); };
    await expect(changeStatus(deps({ audit: failing }), agent, t.reference, { version: 0, to: "in_progress" })).rejects.toThrow(/audit down/);
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: "new", version: 0 });
    expect(await prisma.ticketEvent.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("optimistic concurrency", () => {
  it("a stale version is 409 STALE_VERSION and changes nothing", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    await changeStatus(deps(), agent, t.reference, { version: 0, to: "in_progress" });
    await expect(changeStatus(deps(), agent, t.reference, { version: 0, to: "on_hold", holdReason: "other" })).rejects.toMatchObject({ status: 409, code: "STALE_VERSION" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("in_progress");
  });

  it("two agents taking the same ticket: exactly one wins, the other gets 409", async () => {
    const g = await W.group("Desk");
    const a = await W.actor("agent", [g]);
    const b = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    const results = await Promise.allSettled([
      assignTicket(deps(), a, t.reference, { version: 0, assigneeEmployeeId: "me" }),
      assignTicket(deps(), b, t.reference, { version: 0, assigneeEmployeeId: "me" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: "STALE_VERSION" });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect([a.employeeId, b.employeeId]).toContain(row.assigneeEmployeeId);
    expect(row.version).toBe(1);
  });

  it("20 concurrent writers with the same version: exactly one succeeds", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => changeStatus(deps(), agent, t.reference, { version: 0, to: "in_progress" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id } })).toBe(1);
  });
});

describe("assignment", () => {
  it("an agent in the group takes a ticket (new -> assigned) with event, audit and job", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    const r = await assignTicket(deps(), agent, t.reference, { version: 0, assigneeEmployeeId: "me" });
    expect(r.status).toBe("assigned");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).assigneeEmployeeId).toBe(agent.employeeId);
    expect((await prisma.ticketEvent.findMany({ where: { ticketId: t.id } })).map((e) => e.type).sort()).toEqual(["assigned", "status_changed"]);
    expect(await prisma.auditLog.count({ where: { action: "ticket.assign" } })).toBe(1);
    expect(await prisma.job.count({ where: { kind: "notify.ticket_assigned", dedupeKey: `${t.id}:v1:assigned` } })).toBe(1);
  });

  it("an agent may assign to a colleague in a group they belong to, but not to someone in another group", async () => {
    const mine = await W.group("Mine");
    const other = await W.group("Other");
    const agent = await W.actor("agent", [mine]);
    const colleague = await W.actor("agent", [mine]);
    const outsider = await W.actor("agent", [other]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: mine.id });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0, assigneeEmployeeId: outsider.employeeId })).rejects.toMatchObject({ code: "ASSIGNEE_NOT_IN_GROUP" });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0, assigneeEmployeeId: colleague.employeeId })).resolves.toMatchObject({ status: "assigned" });
  });

  it("an agent who sees a ticket only because it is theirs cannot hand it to a group they are not in", async () => {
    const mine = await W.group("Mine");
    const theirs = await W.group("Theirs");
    const agent = await W.actor("agent", [mine]);
    const target = await W.actor("agent", [theirs]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: theirs.id, assignee: agent });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0, assigneeEmployeeId: target.employeeId })).rejects.toMatchObject({ status: 403 });
  });

  it("managers may assign to any member of the target group", async () => {
    const g = await W.group("Desk");
    const manager = await W.actor("manager");
    const worker = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    await expect(assignTicket(deps(), manager, t.reference, { version: 0, assigneeEmployeeId: worker.employeeId })).resolves.toMatchObject({ status: "assigned" });
  });

  it("changing the group clears an assignee who is not in the new group, and the status falls back to new", async () => {
    const a = await W.group("A");
    const b = await W.group("B");
    const agent = await W.actor("agent", [a]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: a.id, assignee: agent, status: "assigned" });
    await assignTicket(deps(), agent, t.reference, { version: 0, groupId: b.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ assignmentGroupId: b.id, assigneeEmployeeId: null, status: "new" });
  });

  it("changing the group keeps an assignee who is a member of the new group", async () => {
    const a = await W.group("A");
    const b = await W.group("B");
    const agent = await W.actor("agent", [a, b]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: a.id, assignee: agent, status: "assigned" });
    await assignTicket(deps(), agent, t.reference, { version: 0, groupId: b.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ assignmentGroupId: b.id, assigneeEmployeeId: agent.employeeId, status: "assigned" });
  });

  it("unassigning returns an assigned ticket to new but leaves in_progress alone", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const assigned = await W.ticket({ requester: await W.actor("employee"), group: g.id, assignee: agent, status: "assigned" });
    const working = await W.ticket({ requester: await W.actor("employee"), group: g.id, assignee: agent, status: "in_progress" });
    await assignTicket(deps(), agent, assigned.reference, { version: 0, assigneeEmployeeId: null });
    await assignTicket(deps(), agent, working.reference, { version: 0, assigneeEmployeeId: null });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: assigned.id } })).status).toBe("new");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: working.id } })).status).toBe("in_progress");
  });

  it("rejects: employees (403), strangers (404), closed tickets (409), inactive groups (422), no-ops (400)", async () => {
    const g = await W.group("Desk");
    const dead = await prisma.assignmentGroup.create({ data: { name: "Dead", active: false } });
    const emp = await W.actor("employee");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: emp, group: g.id });
    await expect(assignTicket(deps(), emp, t.reference, { version: 0, assigneeEmployeeId: "me" })).rejects.toMatchObject({ status: 403 });
    await expect(assignTicket(deps(), await W.actor("employee"), t.reference, { version: 0, assigneeEmployeeId: "me" })).rejects.toMatchObject({ status: 404 });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0, groupId: dead.id })).rejects.toMatchObject({ code: "GROUP_INVALID" });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0 })).rejects.toMatchObject({ status: 400 });
    const closed = await W.ticket({ requester: emp, group: g.id, status: "closed" });
    await expect(assignTicket(deps(), agent, closed.reference, { version: 0, assigneeEmployeeId: "me" })).rejects.toMatchObject({ status: 409 });
  });

  it("the triage flow: a triage agent takes a ticket that has no group", async () => {
    const triage = await W.group("Service Desk", true);
    const agent = await W.actor("agent", [triage]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: null });
    await expect(assignTicket(deps(), agent, t.reference, { version: 0, assigneeEmployeeId: "me" })).resolves.toMatchObject({ status: "assigned" });
  });
});

describe("field updates", () => {
  const setup = async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    return { g, agent, t };
  };

  it("a priority override needs a reason, is recorded, and can be cleared back to the derived value", async () => {
    const { agent, t } = await setup();
    await expect(updateTicket(deps(), agent, t.reference, { version: 0, priority: "p1" })).rejects.toMatchObject({ status: 400 });
    await updateTicket(deps(), agent, t.reference, { version: 0, priority: "p1", reason: "Executive affected" });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ priority: "p1", priorityOverridden: true, priorityOverrideReason: "Executive affected" });
    expect((await prisma.ticketEvent.findFirstOrThrow({ where: { type: "priority_changed" } })).data).toMatchObject({ overridden: true, reason: "Executive affected" });
    await updateTicket(deps(), agent, t.reference, { version: 1, priority: null });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ priority: "p3", priorityOverridden: false, priorityOverrideReason: null });
  });

  it("changing impact/urgency recomputes the priority unless it was overridden", async () => {
    const { agent, t } = await setup();
    await updateTicket(deps(), agent, t.reference, { version: 0, impact: "high", urgency: "high" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe("p1");
    await updateTicket(deps(), agent, t.reference, { version: 1, priority: "p4", reason: "Agreed with requester" });
    await updateTicket(deps(), agent, t.reference, { version: 2, impact: "low" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe("p4"); // override holds
  });

  it("recomputes the SLA due dates when the priority changes, from the creation time", async () => {
    await prisma.slaPolicy.createMany({ data: [
      { name: "p3", priority: "p3", responseMinutes: 60, resolveMinutes: 600 },
      { name: "p1", priority: "p1", responseMinutes: 10, resolveMinutes: 60 },
    ] });
    const emp = await W.actor("employee");
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock(T0) }, emp, { type: "incident", subject: "Disk full", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal" });
    expect(ticket.resolveDueAt).toBe("2026-03-05T01:00:00.000Z");
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assignmentGroupId: g.id } });
    await updateTicket(deps(), agent, ticket.reference, { version: 0, priority: "p1", reason: "Production impact" });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.resolveDueAt?.toISOString()).toBe("2026-03-04T16:00:00.000Z");
    expect(row.responseDueAt?.toISOString()).toBe("2026-03-04T15:10:00.000Z");
  });

  it("validates the category and the type change, and clears type details on a type change", async () => {
    const { agent, t } = await setup();
    const requestsOnly = await prisma.category.create({ data: { name: "Requests", ticketTypes: ["service_request"] } });
    const inactive = await prisma.category.create({ data: { name: "Old", active: false } });
    await expect(updateTicket(deps(), agent, t.reference, { version: 0, categoryId: requestsOnly.id })).rejects.toMatchObject({ code: "CATEGORY_INVALID" });
    await expect(updateTicket(deps(), agent, t.reference, { version: 0, categoryId: inactive.id })).rejects.toMatchObject({ code: "CATEGORY_INVALID" });
    await prisma.ticket.update({ where: { id: t.id }, data: { typeDetails: { affectedService: "VPN" } } });
    await updateTicket(deps(), agent, t.reference, { version: 0, type: "service_request", categoryId: requestsOnly.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ type: "service_request", categoryId: requestsOnly.id, typeDetails: null, reference: t.reference });
  });

  it("rejects: employees (403), no-ops (400), final tickets (409)", async () => {
    const { agent, t } = await setup();
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: t.requesterEmployeeId } });
    const empActor = { employeeId: emp.id, userAccountId: "x", role: "employee" as const, groupIds: [], triageGroupIds: [] };
    await expect(updateTicket(deps(), empActor, t.reference, { version: 0, impact: "high" })).rejects.toMatchObject({ status: 403 });
    await expect(updateTicket(deps(), agent, t.reference, { version: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(updateTicket(deps(), agent, t.reference, { version: 0, impact: "medium" })).rejects.toMatchObject({ status: 400 }); // same value
    const final = await W.ticket({ requester: await W.actor("employee"), group: t.assignmentGroupId, status: "closed" });
    await expect(updateTicket(deps(), agent, final.reference, { version: 0, impact: "high" })).rejects.toMatchObject({ status: 409 });
  });

  it("audits the before/after of every changed field", async () => {
    const { agent, t } = await setup();
    await updateTicket(deps(), agent, t.reference, { version: 0, impact: "high", urgency: "low" });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "ticket.update" } });
    // high x low is still p3, so priority is correctly NOT listed as changed
    expect(a.changes).toEqual({ impact: ["medium", "high"], urgency: ["medium", "low"] });
  });
});

describe("SLA pause across the lifecycle", () => {
  it("awaiting_requester stops the clock; the requester's reply resumes it and moves the due dates by the time on hold", async () => {
    await prisma.slaPolicy.create({ data: { name: "p3", priority: "p3", responseMinutes: 60, resolveMinutes: 480 } });
    const g = await W.group("Desk");
    const emp = await W.actor("employee");
    const agent = await W.actor("agent", [g]);
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock(T0) }, emp, { type: "incident", subject: "Cannot log in", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal" });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assignmentGroupId: g.id } });
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });

    await changeStatus(deps({ clock: fixedClock(at(10)) }), agent, ticket.reference, { version: 0, to: "on_hold", holdReason: "awaiting_requester" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).slaPausedAt?.toISOString()).toBe(at(10).toISOString());

    // the requester answers 90 minutes later
    const r = await addMessage({ db: prisma, clock: fixedClock(at(100)) }, emp, ticket.reference, { body: "Here are the details", visibility: "public", attachmentIds: [] });
    expect(r.status).toBe("in_progress");
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after).toMatchObject({ status: "in_progress", holdReason: null, slaPausedAt: null, slaPausedMinutes: 90 });
    expect(after.resolveDueAt!.getTime() - before.resolveDueAt!.getTime()).toBe(90 * 60_000);
    expect(after.responseDueAt!.getTime() - before.responseDueAt!.getTime()).toBe(90 * 60_000);
    expect(after.version).toBe(2);
  });

  it("a hold reason that does not pause leaves the clock running", async () => {
    await prisma.slaPolicy.create({ data: { name: "p3", priority: "p3", responseMinutes: 60, resolveMinutes: 480 } });
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock(T0) }, await W.actor("employee"), { type: "incident", subject: "Vendor issue", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal" });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assignmentGroupId: g.id } });
    await changeStatus(deps({ clock: fixedClock(at(10)) }), agent, ticket.reference, { version: 0, to: "on_hold", holdReason: "awaiting_vendor" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).slaPausedAt).toBeNull();
  });

  it("the pausing hold reasons are configurable ([OPEN])", async () => {
    await prisma.companySetting.create({ data: { key: "sla.pauseHoldReasons", value: ["awaiting_requester", "awaiting_vendor"] } });
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id, responseDueAt: at(60), resolveDueAt: at(480) });
    await changeStatus(deps({ clock: fixedClock(at(10)) }), agent, t.reference, { version: 0, to: "on_hold", holdReason: "awaiting_vendor" });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).slaPausedAt).not.toBeNull();
  });

  it("resolving straight out of a pausing hold also resumes the clock", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id, status: "on_hold", holdReason: "awaiting_requester", slaPausedAt: at(0), resolveDueAt: at(300) });
    await changeStatus(deps({ clock: fixedClock(at(45)) }), agent, t.reference, { version: 0, to: "resolved" });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.slaPausedAt).toBeNull();
    expect(row.slaPausedMinutes).toBe(45);
    expect(row.resolveDueAt?.toISOString()).toBe(at(345).toISOString());
  });
});

describe("archive", () => {
  it("only managers and admins can archive; the ticket then disappears from detail and lists", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const manager = await W.actor("manager");
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id });
    await expect(archiveTicket(deps(), agent, t.reference, { version: 0 })).rejects.toMatchObject({ status: 403 });
    await archiveTicket(deps(), manager, t.reference, { version: 0, reason: "Duplicate of another ticket" });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ archivedByEmployeeId: manager.employeeId });
    expect(await getTicketDetail(prisma, manager, t.reference)).toBeNull();
    await expect(archiveTicket(deps(), manager, t.reference, { version: 1 })).rejects.toMatchObject({ status: 404 });
    expect(await prisma.auditLog.count({ where: { action: "ticket.archive" } })).toBe(1);
    expect(await prisma.ticket.count()).toBe(1); // never hard-deleted
  });

  it("respects the version", async () => {
    const manager = await W.actor("manager");
    const t = await W.ticket({ requester: await W.actor("employee") });
    await expect(archiveTicket(deps(), manager, t.reference, { version: 5 })).rejects.toMatchObject({ code: "STALE_VERSION" });
  });
});
