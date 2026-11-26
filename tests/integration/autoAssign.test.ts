import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { autoAssignee, pickLeastLoaded, pickRoundRobin } from "@/modules/assignment/autoAssign";
import { assignTicket } from "@/modules/tickets/assign";
import { createTicket } from "@/modules/tickets/createTicket";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

async function team(strategy: "round_robin" | "least_loaded" | "manual", size = 3) {
  const g = await prisma.assignmentGroup.create({ data: { name: `G-${strategy}-${Math.random()}`, strategy } });
  const members = [];
  for (let i = 0; i < size; i++) members.push(await W.actor("agent", [g]));
  return { g, members };
}
const create = (who: Awaited<ReturnType<typeof W.actor>>, categoryId?: string) =>
  createTicket({ db: prisma }, who, { type: "incident", subject: "Auto assigned?", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal", categoryId });
async function categoryFor(groupId: string) {
  return (await prisma.category.create({ data: { name: `Cat-${Math.random()}`, defaultGroupId: groupId } })).id;
}

describe("round robin", () => {
  it("hands out tickets in turn, evenly", async () => {
    const { g, members } = await team("round_robin", 3);
    const picks: string[] = [];
    for (let i = 0; i < 9; i++) picks.push((await pickRoundRobin(prisma, g.id))!);
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3, 3]);
    expect(new Set(picks.slice(0, 3)).size).toBe(3); // the first three are all different
    expect(new Set(counts.keys())).toEqual(new Set(members.map((m) => m.employeeId)));
  });

  it("skips disabled members: directory-disabled, ineligible, removed, account-disabled, and plain employees", async () => {
    const { g, members } = await team("round_robin", 2);
    const bad = [
      await W.actor("agent", [g], { accountEnabled: false }),
      await W.actor("agent", [g], { isEligible: false }),
      await W.actor("agent", [g], { directoryDeletedAt: new Date() }),
      await W.actor("employee", [g]),
    ];
    const disabledAccount = await W.actor("agent", [g]);
    await prisma.userAccount.update({ where: { id: disabledAccount.userAccountId }, data: { status: "disabled" } });
    const noAccount = await W.person();
    await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: noAccount.id } });
    const forbidden = new Set([...bad.map((b) => b.employeeId), disabledAccount.employeeId, noAccount.id]);
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) picks.add((await pickRoundRobin(prisma, g.id))!);
    expect(picks).toEqual(new Set(members.map((m) => m.employeeId)));
    for (const f of forbidden) expect(picks.has(f)).toBe(false);
  });

  it("returns null for an empty group, and nobody is chosen when every member is unavailable", async () => {
    const g = await prisma.assignmentGroup.create({ data: { name: "Empty", strategy: "round_robin" } });
    expect(await pickRoundRobin(prisma, g.id)).toBeNull();
    await W.actor("agent", [g], { accountEnabled: false });
    expect(await pickRoundRobin(prisma, g.id)).toBeNull();
  });

  it("concurrent picks get different positions: 30 parallel picks over 3 agents is exactly 10 each", async () => {
    const { g } = await team("round_robin", 3);
    const picks = await Promise.all(Array.from({ length: 30 }, () => prisma.$transaction((tx) => pickRoundRobin(tx as never, g.id))));
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p!, (counts.get(p!) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([10, 10, 10]);
  });
});

describe("least loaded", () => {
  const load = async (assignee: string, n: number, status = "in_progress") => {
    const e = await W.actor("employee");
    for (let i = 0; i < n; i++) await W.ticket({ requester: e, assignee: { employeeId: assignee } as never, status });
  };

  it("picks the member with the fewest open tickets", async () => {
    const { g, members } = await team("least_loaded", 3);
    await load(members[0].employeeId, 3);
    await load(members[1].employeeId, 1);
    await load(members[2].employeeId, 2);
    expect(await pickLeastLoaded(prisma, g.id)).toBe(members[1].employeeId);
  });

  it("closed, resolved, cancelled and archived tickets do not count as load", async () => {
    const { g, members } = await team("least_loaded", 2);
    await load(members[0].employeeId, 4, "closed");
    await load(members[0].employeeId, 2, "resolved");
    await load(members[1].employeeId, 1, "in_progress");
    expect(await pickLeastLoaded(prisma, g.id)).toBe(members[0].employeeId);
  });

  it("breaks ties towards whoever was assigned work longest ago, so a tie does not always pick the same person", async () => {
    const { g, members } = await team("least_loaded", 2);
    await load(members[0].employeeId, 1, "closed"); // 0 open each, but member 0 had work more recently
    await new Promise((r) => setTimeout(r, 15));
    await load(members[1].employeeId, 0);
    const first = await pickLeastLoaded(prisma, g.id);
    expect(first).toBe(members[1].employeeId); // never had any work -> waiting longest
  });

  it("ignores unavailable members even if they have no load", async () => {
    const { g, members } = await team("least_loaded", 1);
    await W.actor("agent", [g], { accountEnabled: false });
    expect(await pickLeastLoaded(prisma, g.id)).toBe(members[0].employeeId);
  });
});

describe("autoAssignee dispatch", () => {
  it("manual groups, inactive groups, missing groups and null all give nobody", async () => {
    const manual = await team("manual", 2);
    expect(await autoAssignee(prisma, manual.g.id)).toBeNull();
    expect(await autoAssignee(prisma, null)).toBeNull();
    expect(await autoAssignee(prisma, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const rr = await team("round_robin", 2);
    await prisma.assignmentGroup.update({ where: { id: rr.g.id }, data: { active: false } });
    expect(await autoAssignee(prisma, rr.g.id)).toBeNull();
  });
});

describe("integration with ticket creation", () => {
  it("a new ticket routed to a round-robin group is assigned immediately (status assigned) and says so in the event and audit", async () => {
    const { g, members } = await team("round_robin", 2);
    const cat = await categoryFor(g.id);
    const { ticket } = await create(await W.actor("employee"), cat);
    expect(ticket.status).toBe("assigned");
    expect(members.map((m) => m.employeeId)).toContain(ticket.assignee!.id);
    expect((await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, type: "created" } })).data).toMatchObject({ autoAssigned: true });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "ticket.create" } })).changes).toMatchObject({ autoAssigned: true });
    expect((await prisma.job.findFirstOrThrow({ where: { kind: "notify.ticket_assigned" } })).payload).toMatchObject({ assigneeEmployeeId: ticket.assignee!.id });
  });

  it("successive tickets alternate between agents", async () => {
    const { g } = await team("round_robin", 2);
    const cat = await categoryFor(g.id);
    const emp = await W.actor("employee");
    const owners: string[] = [];
    for (let i = 0; i < 6; i++) owners.push((await create(emp, cat)).ticket.assignee!.id);
    expect(new Set(owners).size).toBe(2);
    expect(owners.filter((o) => o === owners[0]).length).toBe(3);
  });

  it("a manual group leaves new tickets unassigned; a group with nobody available does too", async () => {
    const manual = await team("manual", 2);
    expect((await create(await W.actor("employee"), await categoryFor(manual.g.id))).ticket).toMatchObject({ status: "new", assignee: null });
    const empty = await prisma.assignmentGroup.create({ data: { name: "NobodyHome", strategy: "least_loaded" } });
    expect((await create(await W.actor("employee"), await categoryFor(empty.id))).ticket).toMatchObject({ status: "new", assignee: null });
  });

  it("an explicit assignee given by an agent wins over the strategy and does not advance the cursor", async () => {
    const { g, members } = await team("round_robin", 3);
    const agent = await W.actor("agent", [g]);
    const jane = await W.person();
    await createTicket({ db: prisma }, agent, { type: "incident", subject: "Explicit", description: "d", attachmentIds: [], requester: { kind: "employee", employeeId: jane.id }, channel: "phone", assignmentGroupId: g.id, assigneeEmployeeId: members[2].employeeId });
    expect((await prisma.assignmentGroup.findUniqueOrThrow({ where: { id: g.id } })).rrCursor).toBe(0);
    expect((await prisma.ticket.findFirstOrThrow()).assigneeEmployeeId).toBe(members[2].employeeId);
  });

  it("50 parallel creations spread over the agents with unique references", async () => {
    const { g, members } = await team("round_robin", 5);
    const cat = await categoryFor(g.id);
    const emp = await W.actor("employee");
    const results = await Promise.all(Array.from({ length: 50 }, () => create(emp, cat)));
    expect(new Set(results.map((r) => r.ticket.reference)).size).toBe(50);
    const per = new Map<string, number>();
    for (const r of results) per.set(r.ticket.assignee!.id, (per.get(r.ticket.assignee!.id) ?? 0) + 1);
    expect([...per.values()].sort()).toEqual([10, 10, 10, 10, 10]);
    expect(per.size).toBe(members.length);
  });
});

describe("integration with reassignment to another group", () => {
  it("moving a ticket to a least-loaded group picks that group's best agent without a permission error", async () => {
    const from = await prisma.assignmentGroup.create({ data: { name: "From" } });
    const { g: to, members } = await team("least_loaded", 2);
    const agent = await W.actor("agent", [from]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: from.id, assignee: agent, status: "assigned" });
    await assignTicket({ db: prisma }, agent, t.reference, { version: 0, groupId: to.id });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.assignmentGroupId).toBe(to.id);
    expect(members.map((m) => m.employeeId)).toContain(row.assigneeEmployeeId);
    expect(row.status).toBe("assigned");
  });

  it("moving to a manual group still clears the assignee and returns the ticket to new", async () => {
    const from = await prisma.assignmentGroup.create({ data: { name: "From" } });
    const { g: to } = await team("manual", 2);
    const agent = await W.actor("agent", [from]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: from.id, assignee: agent, status: "assigned" });
    await assignTicket({ db: prisma }, agent, t.reference, { version: 0, groupId: to.id });
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ assignmentGroupId: to.id, assigneeEmployeeId: null, status: "new" });
  });
});
