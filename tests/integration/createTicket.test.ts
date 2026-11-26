import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import type { AppRole } from "@/modules/identity/roleMapping";
import { createTicket, type CreateTicketCommand } from "@/modules/tickets/createTicket";
import { fixedClock } from "@/platform/clock";
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from "@/platform/errors";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
const deps = { db: prisma };

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

let n = 0;
async function person(over: Record<string, unknown> = {}) {
  n += 1;
  return prisma.employee.create({
    data: { entraObjectId: randomUUID(), userPrincipalName: `p${n}@example.test`, mail: `p${n}@example.test`, displayName: `Person ${n}`, ...over },
  });
}
async function actorOf(role: AppRole, over: Record<string, unknown> = {}): Promise<Actor> {
  const e = await person(over);
  const a = await prisma.userAccount.create({ data: { employeeId: e.id, role } });
  return { employeeId: e.id, userAccountId: a.id, role, groupIds: [], triageGroupIds: [] };
}

const base = { type: "incident" as const, subject: "Printer is broken", description: "It will not print.", attachmentIds: [] as string[] };
const self = (over: Partial<CreateTicketCommand> = {}): CreateTicketCommand => ({ ...base, requester: { kind: "self" }, channel: "portal", ...over });
const assisted = (employeeId: string, over: Partial<CreateTicketCommand> = {}): CreateTicketCommand => ({
  ...base, requester: { kind: "employee", employeeId }, channel: "phone", ...over,
});

describe("self-service (Form B)", () => {
  it("makes the actor both requester and creator, with snapshots read from the Employee row", async () => {
    const dept = await prisma.department.create({ data: { name: "Finance" } });
    const loc = await prisma.location.create({ data: { name: "HQ" } });
    const actor = await actorOf("employee", { jobTitle: "Analyst", departmentId: dept.id, locationId: loc.id, displayName: "Jane Doe", mail: "jane@example.test" });
    const { ticket, replayed } = await createTicket(deps, actor, self());
    expect(replayed).toBe(false);
    expect(ticket.requester).toMatchObject({ id: actor.employeeId, displayName: "Jane Doe", mail: "jane@example.test", department: "Finance", jobTitle: "Analyst", location: "HQ" });
    expect(ticket.createdBy.id).toBe(actor.employeeId);
    expect(ticket.onBehalf).toBe(false);
    expect(ticket.channel).toBe("portal");
    expect(ticket.status).toBe("new");
    expect(ticket.reference).toMatch(/^INC\d{7}$/);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row).toMatchObject({ requesterEmployeeId: actor.employeeId, createdByEmployeeId: actor.employeeId, requesterName: "Jane Doe" });
  });

  it("a service request gets a REQ reference", async () => {
    const actor = await actorOf("employee");
    const { ticket } = await createTicket(deps, actor, self({ type: "service_request" }));
    expect(ticket.reference).toMatch(/^REQ\d{7}$/);
  });

  it("a location note overrides the directory location in the snapshot only", async () => {
    const loc = await prisma.location.create({ data: { name: "HQ" } });
    const actor = await actorOf("employee", { locationId: loc.id });
    const { ticket } = await createTicket(deps, actor, self({ locationNote: "3rd floor, desk 12" }));
    expect(ticket.requester.location).toBe("3rd floor, desk 12");
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: actor.employeeId } })).locationId).toBe(loc.id);
  });

  it("ignores any role-ish data: the service decides from the actor only", async () => {
    const employee = await actorOf("employee");
    await expect(createTicket(deps, employee, self({ priorityOverride: { priority: "p1", reason: "I am important" } }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTicket(deps, employee, self({ assignmentGroupId: randomUUID() }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTicket(deps, employee, self({ assigneeEmployeeId: randomUUID() }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.ticket.count()).toBe(0);
  });

  it("stores only sanitised type details", async () => {
    const actor = await actorOf("employee");
    const { ticket } = await createTicket(deps, actor, self({ typeDetails: { affectedService: " VPN ", approvalRequired: true, junk: 1 } }));
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).typeDetails).toEqual({ affectedService: "VPN" });
  });

  it("rejects attachments until the attachment phase lands", async () => {
    const actor = await actorOf("employee");
    await expect(createTicket(deps, actor, self({ attachmentIds: [randomUUID()] }))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("assisted (Form A)", () => {
  it("records the selected person as requester and the agent as creator, with the channel", async () => {
    const agent = await actorOf("agent");
    const jane = await person({ displayName: "Jane Requester", jobTitle: "Accountant" });
    const { ticket } = await createTicket(deps, agent, assisted(jane.id));
    expect(ticket.requester).toMatchObject({ id: jane.id, displayName: "Jane Requester", jobTitle: "Accountant" });
    expect(ticket.createdBy.id).toBe(agent.employeeId);
    expect(ticket.onBehalf).toBe(true);
    expect(ticket.channel).toBe("phone");
    const ev = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, type: "created" } });
    expect(ev.data).toMatchObject({ channel: "phone", onBehalf: true });
    expect(ev.actorEmployeeId).toBe(agent.employeeId);
  });

  it("an employee-role user gets 403; a submitter may file on behalf", async () => {
    const jane = await person();
    await expect(createTicket(deps, await actorOf("employee"), assisted(jane.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTicket(deps, await actorOf("submitter"), assisted(jane.id))).resolves.toMatchObject({ replayed: false });
  });

  it("a submitter cannot use the agent-only fields", async () => {
    const jane = await person();
    const submitter = await actorOf("submitter");
    await expect(createTicket(deps, submitter, assisted(jane.id, { priorityOverride: { priority: "p1", reason: "urgent please" } }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createTicket(deps, submitter, assisted(jane.id, { assignmentGroupId: randomUUID() }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("re-validates the requester server-side: unknown, disabled, ineligible (guest) or removed people are 422", async () => {
    const agent = await actorOf("agent");
    const bad = [
      randomUUID(),
      (await person({ accountEnabled: false })).id,
      (await person({ isEligible: false })).id,
      (await person({ directoryDeletedAt: new Date() })).id,
    ];
    for (const id of bad) {
      await expect(createTicket(deps, agent, assisted(id))).rejects.toMatchObject({ status: 422, code: "REQUESTER_NOT_ELIGIBLE" });
    }
    expect(await prisma.ticket.count()).toBe(0);
  });

  it("a requester who has never signed in (no UserAccount) is fine", async () => {
    const agent = await actorOf("agent");
    const neverSignedIn = await person();
    expect(await prisma.userAccount.findUnique({ where: { employeeId: neverSignedIn.id } })).toBeNull();
    await expect(createTicket(deps, agent, assisted(neverSignedIn.id))).resolves.toBeDefined();
  });

  it("applies a priority override only with the agent role and records it", async () => {
    const agent = await actorOf("agent");
    const jane = await person();
    const { ticket } = await createTicket(deps, agent, assisted(jane.id, { impact: "low", urgency: "low", priorityOverride: { priority: "p1", reason: "CEO is affected" } }));
    expect(ticket).toMatchObject({ priority: "p1", priorityOverridden: true });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(row.priorityOverrideReason).toBe("CEO is affected");
    expect((await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id } })).data).toMatchObject({ derivedPriority: "p4" });
  });
});

describe("priority, category and routing", () => {
  it("defaults to medium/medium (p3) and honours explicit impact/urgency", async () => {
    const actor = await actorOf("employee");
    expect((await createTicket(deps, actor, self())).ticket).toMatchObject({ impact: "medium", urgency: "medium", priority: "p3" });
    expect((await createTicket(deps, actor, self({ impact: "high", urgency: "high" }))).ticket.priority).toBe("p1");
    expect((await createTicket(deps, actor, self({ impact: "low", urgency: "low" }))).ticket.priority).toBe("p4");
  });

  it("uses the category's default impact/urgency and default group", async () => {
    const net = await prisma.assignmentGroup.create({ data: { name: "Network" } });
    const cat = await prisma.category.create({ data: { name: "Network", ticketTypes: ["incident"], defaultGroupId: net.id, defaultImpact: "high", defaultUrgency: "high" } });
    const actor = await actorOf("employee");
    const { ticket } = await createTicket(deps, actor, self({ categoryId: cat.id }));
    expect(ticket).toMatchObject({ priority: "p1", assignmentGroup: { id: net.id, name: "Network" }, category: { id: cat.id } });
  });

  it("falls back to the triage group when the category has no default group", async () => {
    const triage = await prisma.assignmentGroup.create({ data: { name: "Service Desk", isTriage: true } });
    const cat = await prisma.category.create({ data: { name: "General" } });
    const actor = await actorOf("employee");
    expect((await createTicket(deps, actor, self({ categoryId: cat.id }))).ticket.assignmentGroup?.id).toBe(triage.id);
    expect((await createTicket(deps, actor, self())).ticket.assignmentGroup?.id).toBe(triage.id);
  });

  it("leaves the ticket ungrouped when there is no triage group either", async () => {
    const actor = await actorOf("employee");
    expect((await createTicket(deps, actor, self())).ticket.assignmentGroup).toBeNull();
  });

  it("does not route to an inactive default group", async () => {
    const dead = await prisma.assignmentGroup.create({ data: { name: "Dead", active: false } });
    const triage = await prisma.assignmentGroup.create({ data: { name: "Service Desk", isTriage: true } });
    const cat = await prisma.category.create({ data: { name: "Old", defaultGroupId: dead.id } });
    const actor = await actorOf("employee");
    expect((await createTicket(deps, actor, self({ categoryId: cat.id }))).ticket.assignmentGroup?.id).toBe(triage.id);
  });

  it("rejects an unknown, inactive or wrong-type category with 422", async () => {
    const actor = await actorOf("employee");
    const inactive = await prisma.category.create({ data: { name: "Gone", active: false } });
    const requestsOnly = await prisma.category.create({ data: { name: "Requests", ticketTypes: ["service_request"] } });
    for (const categoryId of [randomUUID(), inactive.id, requestsOnly.id]) {
      await expect(createTicket(deps, actor, self({ categoryId }))).rejects.toMatchObject({ status: 422, code: "CATEGORY_INVALID" });
    }
  });

  it("an agent can pick an explicit group and an assignee who belongs to it (status becomes assigned)", async () => {
    const agent = await actorOf("agent");
    const worker = await person();
    const g = await prisma.assignmentGroup.create({ data: { name: "Desktop" } });
    await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: worker.id } });
    const jane = await person();
    const { ticket } = await createTicket(deps, agent, assisted(jane.id, { assignmentGroupId: g.id, assigneeEmployeeId: worker.id }));
    expect(ticket).toMatchObject({ status: "assigned", assignmentGroup: { id: g.id }, assignee: { id: worker.id } });
  });

  it("rejects an assignee who is not in the group, and an inactive or unknown group (422)", async () => {
    const agent = await actorOf("agent");
    const outsider = await person();
    const g = await prisma.assignmentGroup.create({ data: { name: "Desktop" } });
    const dead = await prisma.assignmentGroup.create({ data: { name: "Dead", active: false } });
    const jane = await person();
    await expect(createTicket(deps, agent, assisted(jane.id, { assignmentGroupId: g.id, assigneeEmployeeId: outsider.id }))).rejects.toMatchObject({ code: "ASSIGNEE_NOT_IN_GROUP" });
    await expect(createTicket(deps, agent, assisted(jane.id, { assignmentGroupId: dead.id }))).rejects.toMatchObject({ code: "GROUP_INVALID" });
    await expect(createTicket(deps, agent, assisted(jane.id, { assignmentGroupId: randomUUID() }))).rejects.toBeInstanceOf(UnprocessableError);
    expect(await prisma.ticket.count()).toBe(0);
  });

  it("rejects an assignee who has been disabled in the directory", async () => {
    const agent = await actorOf("agent");
    const worker = await person({ accountEnabled: false });
    const g = await prisma.assignmentGroup.create({ data: { name: "Desktop" } });
    await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: worker.id } });
    await expect(createTicket(deps, agent, assisted((await person()).id, { assignmentGroupId: g.id, assigneeEmployeeId: worker.id }))).rejects.toMatchObject({ code: "ASSIGNEE_NOT_IN_GROUP" });
  });
});

describe("SLA due dates", () => {
  const NOW = "2026-03-06T22:30:00Z"; // Fri 17:30 New York (EST)

  it("has no due dates when no policy exists (targets are never invented)", async () => {
    const { ticket } = await createTicket(deps, await actorOf("employee"), self());
    expect(ticket.responseDueAt).toBeNull();
    expect(ticket.resolveDueAt).toBeNull();
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).slaPolicyId).toBeNull();
  });

  it("24x7 policy (no calendar): plain addition from the creation time", async () => {
    await prisma.slaPolicy.create({ data: { name: "p3", priority: "p3", responseMinutes: 60, resolveMinutes: 1440 } });
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock(NOW) }, await actorOf("employee"), self());
    expect(ticket.responseDueAt).toBe("2026-03-06T23:30:00.000Z");
    expect(ticket.resolveDueAt).toBe("2026-03-07T22:30:00.000Z");
  });

  it("business-hours policy skips the weekend and a holiday", async () => {
    const cal = await prisma.businessCalendar.create({ data: { name: "NY", timezone: "America/New_York", workDays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 } });
    await prisma.businessHoliday.create({ data: { calendarId: cal.id, date: new Date("2026-03-09"), name: "Company day" } });
    await prisma.slaPolicy.create({ data: { name: "p3", priority: "p3", responseMinutes: 60, resolveMinutes: 480, calendarId: cal.id } });
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock(NOW) }, await actorOf("employee"), self());
    // Fri 17:30 + 60 min: 30 Fri, Mon 03-09 is a holiday -> Tue 03-10 09:30 EDT = 13:30Z
    expect(ticket.responseDueAt).toBe("2026-03-10T13:30:00.000Z");
    // 480 min = 30 Fri + 450 on Tue (09:00 -> 16:30 EDT = 20:30Z)
    expect(ticket.resolveDueAt).toBe("2026-03-10T20:30:00.000Z");
  });

  it("prefers a type-specific policy over an all-types one, and ignores inactive ones", async () => {
    await prisma.slaPolicy.create({ data: { name: "all", priority: "p3", responseMinutes: 100, resolveMinutes: 200 } });
    await prisma.slaPolicy.create({ data: { name: "incident", priority: "p3", ticketType: "incident", responseMinutes: 10, resolveMinutes: 20 } });
    await prisma.slaPolicy.create({ data: { name: "off", priority: "p3", ticketType: "service_request", active: false, responseMinutes: 1, resolveMinutes: 2 } });
    const actor = await actorOf("employee");
    const clock = fixedClock("2026-03-06T12:00:00Z");
    const inc = (await createTicket({ db: prisma, clock }, actor, self())).ticket;
    expect(inc.responseDueAt).toBe("2026-03-06T12:10:00.000Z");
    const req = (await createTicket({ db: prisma, clock }, actor, self({ type: "service_request" }))).ticket;
    expect(req.responseDueAt).toBe("2026-03-06T13:40:00.000Z"); // falls back to the all-types policy
  });

  it("uses the priority of an override, not the derived one", async () => {
    await prisma.slaPolicy.create({ data: { name: "p1", priority: "p1", responseMinutes: 5, resolveMinutes: 30 } });
    const { ticket } = await createTicket({ db: prisma, clock: fixedClock("2026-03-06T12:00:00Z") }, await actorOf("agent"), assisted((await person()).id, { impact: "low", urgency: "low", priorityOverride: { priority: "p1", reason: "executive" } }));
    expect(ticket.responseDueAt).toBe("2026-03-06T12:05:00.000Z");
  });
});

describe("idempotency", () => {
  const KEY = "key-aaaaaaaa-0001";

  it("the same key and body returns the same ticket, marked as a replay", async () => {
    const actor = await actorOf("employee");
    const a = await createTicket(deps, actor, self({ idempotencyKey: KEY }));
    const b = await createTicket(deps, actor, self({ idempotencyKey: KEY }));
    expect(b.replayed).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it("the same key with a different body is a 409", async () => {
    const actor = await actorOf("employee");
    await createTicket(deps, actor, self({ idempotencyKey: KEY }));
    await expect(createTicket(deps, actor, self({ idempotencyKey: KEY, subject: "A different problem" }))).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it("different users may use the same key and get two tickets", async () => {
    const a = await createTicket(deps, await actorOf("employee"), self({ idempotencyKey: KEY }));
    const b = await createTicket(deps, await actorOf("employee"), self({ idempotencyKey: KEY }));
    expect(a.ticket.id).not.toBe(b.ticket.id);
    expect(b.replayed).toBe(false);
  });

  it("without a key every call creates a ticket", async () => {
    const actor = await actorOf("employee");
    await createTicket(deps, actor, self());
    await createTicket(deps, actor, self());
    expect(await prisma.ticket.count()).toBe(2);
  });

  it("concurrent requests with the same key create exactly one ticket", async () => {
    const actor = await actorOf("employee");
    const results = await Promise.all(Array.from({ length: 10 }, () => createTicket(deps, actor, self({ idempotencyKey: KEY }))));
    expect(new Set(results.map((r) => r.ticket.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.ticket.count()).toBe(1);
    expect(await prisma.ticketEvent.count()).toBe(1);
  });

  it("a replay does not repeat side effects", async () => {
    const actor = await actorOf("employee");
    await createTicket(deps, actor, self({ idempotencyKey: KEY }));
    await createTicket(deps, actor, self({ idempotencyKey: KEY }));
    expect(await prisma.job.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "ticket.create" } })).toBe(1);
  });
});

describe("concurrency and atomicity", () => {
  it("50 parallel creates yield 50 unique numbers and references", async () => {
    const actor = await actorOf("employee");
    const results = await Promise.all(Array.from({ length: 50 }, () => createTicket(deps, actor, self())));
    expect(new Set(results.map((r) => r.ticket.reference)).size).toBe(50);
    expect(new Set(results.map((r) => r.ticket.number)).size).toBe(50);
  });

  it("an injected audit failure leaves no ticket, event or job behind", async () => {
    const actor = await actorOf("employee");
    const failing = async () => { throw new Error("audit write failed"); };
    await expect(createTicket({ db: prisma, audit: failing }, actor, self())).rejects.toThrow(/audit write failed/);
    expect(await prisma.ticket.count()).toBe(0);
    expect(await prisma.ticketEvent.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("writes exactly one created event, one audit row and the two outbox jobs with dedupe keys", async () => {
    const triage = await prisma.assignmentGroup.create({ data: { name: "Service Desk", isTriage: true } });
    const agent = await actorOf("agent");
    const jane = await person();
    const { ticket } = await createTicket(deps, agent, assisted(jane.id));
    expect(await prisma.ticketEvent.findMany({ where: { ticketId: ticket.id } })).toHaveLength(1);
    const audit = await prisma.auditLog.findMany({ where: { ticketId: ticket.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "ticket.create", actorEmployeeId: agent.employeeId, entityType: "ticket" });
    expect(audit[0].changes).toMatchObject({ requesterEmployeeId: jane.id, onBehalf: true, assignmentGroupId: triage.id });
    const jobs = await prisma.job.findMany({ orderBy: { kind: "asc" } });
    expect(jobs.map((j) => [j.kind, j.dedupeKey])).toEqual([
      ["notify.ticket_assigned", `${ticket.id}:assigned`],
      ["notify.ticket_created", `${ticket.id}:created`],
    ]);
    expect(jobs.find((j) => j.kind === "notify.ticket_created")!.payload).toMatchObject({ ticketId: ticket.id, recipientEmployeeId: jane.id });
  });

  it("never writes secrets or the full request into the audit trail", async () => {
    const actor = await actorOf("employee");
    await createTicket(deps, actor, self({ description: "my password is hunter2" }));
    const rows = await prisma.auditLog.findMany();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("hunter2");
  });
});
