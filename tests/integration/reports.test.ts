import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { mySummary, reportSummary, type ReportSummary } from "@/modules/reporting/queries";
import { reportScopeSql } from "@/modules/reporting/scope";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const NOW = new Date("2026-03-10T12:00:00Z");
const RANGE = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-11T00:00:00Z") }; // 1-10 March, inclusive
const at = (s: string) => new Date(`${s}Z`);

/**
 * HAND-COMPUTED FIXTURE. Times are UTC; "now" is 2026-03-10 12:00. G1 = Desk (agent A1), G2 = Net (agent A2), plus group-less tickets.
 *
 *  id  group  status       prio created          firstResp (min)   respDue         resolved (min)         resolveDue      resolvedBy
 *  T1  G1     new          p1   03-09 10:00      -                 03-09 10:15     -                      03-09 14:00     -
 *  T2  G1     in_progress  p2   03-05 12:00      03-05 12:30 (30)  03-05 13:00     -                      03-12 12:00     -   (assignee A1)
 *  T3  G1     on_hold*     p3   03-02 12:00      03-02 12:10 (10)  03-02 13:00     -                      03-03 12:00     -   (*awaiting requester, clock paused)
 *  T4  G2     assigned     p3   03-09 08:00      -                 -               -                      -               -
 *  T5  G1     resolved     p4   03-04 08:00      03-04 08:20 (20)  03-04 09:00     03-04 18:00 (600)      03-04 20:00     A1
 *  T6  G1     resolved     p2   03-06 08:00      03-06 11:00 (180) 03-06 09:00     03-07 08:00 (1440)     03-07 07:00     A1
 *  T7  G2     closed       p3   03-03 00:00      03-03 01:00 (60)  03-03 02:00     03-03 06:00 (360)      03-03 12:00     A2
 *  T8  G1     resolved     p3   02-20 10:00 (before the range)      resolved 03-02 10:00 (14400)          03-01 10:00     A1
 *  T9  G1     cancelled    p3   03-08 09:00
 *  T10 G1     new          p3   03-09 09:00      ARCHIVED: must appear nowhere
 *  T11 none   new          p4   03-10 06:00
 */
async function fixture() {
  const g1 = await W.group("Desk");
  const g2 = await W.group("Net");
  const triage = await W.group("Service Desk", true);
  const a1 = await W.actor("agent", [g1], { displayName: "Alice Agent" });
  const a2 = await W.actor("agent", [g2], { displayName: "Bob Agent" });
  const a3 = await W.actor("agent", [triage], { displayName: "Tina Triage" });
  const manager = await W.actor("manager");
  const emp = await W.actor("employee");
  const mk = async (name: string, f: Parameters<typeof W.ticket>[0], extra: Record<string, unknown> = {}) => {
    const t = await W.ticket({ subject: name, ...f });
    if (Object.keys(extra).length) await prisma.ticket.update({ where: { id: t.id }, data: extra as never });
    return t;
  };
  const r = emp;
  await mk("T1", { requester: r, group: g1.id, status: "new", priority: "p1", createdAt: at("2026-03-09T10:00:00"), responseDueAt: at("2026-03-09T10:15:00"), resolveDueAt: at("2026-03-09T14:00:00") });
  await mk("T2", { requester: r, group: g1.id, status: "in_progress", priority: "p2", assignee: a1, createdAt: at("2026-03-05T12:00:00"), responseDueAt: at("2026-03-05T13:00:00"), resolveDueAt: at("2026-03-12T12:00:00") }, { firstRespondedAt: at("2026-03-05T12:30:00") });
  await mk("T3", { requester: r, group: g1.id, status: "on_hold", holdReason: "awaiting_requester", slaPausedAt: at("2026-03-02T13:00:00"), priority: "p3", createdAt: at("2026-03-02T12:00:00"), responseDueAt: at("2026-03-02T13:00:00"), resolveDueAt: at("2026-03-03T12:00:00") }, { firstRespondedAt: at("2026-03-02T12:10:00") });
  await mk("T4", { requester: r, group: g2.id, status: "assigned", priority: "p3", createdAt: at("2026-03-09T08:00:00") });
  await mk("T5", { requester: r, group: g1.id, status: "resolved", priority: "p4", createdAt: at("2026-03-04T08:00:00"), responseDueAt: at("2026-03-04T09:00:00"), resolveDueAt: at("2026-03-04T20:00:00"), resolvedAt: at("2026-03-04T18:00:00") }, { firstRespondedAt: at("2026-03-04T08:20:00"), resolvedByEmployeeId: a1.employeeId });
  await mk("T6", { requester: r, group: g1.id, status: "resolved", priority: "p2", createdAt: at("2026-03-06T08:00:00"), responseDueAt: at("2026-03-06T09:00:00"), resolveDueAt: at("2026-03-07T07:00:00"), resolvedAt: at("2026-03-07T08:00:00") }, { firstRespondedAt: at("2026-03-06T11:00:00"), resolvedByEmployeeId: a1.employeeId });
  await mk("T7", { requester: r, group: g2.id, status: "closed", priority: "p3", createdAt: at("2026-03-03T00:00:00"), responseDueAt: at("2026-03-03T02:00:00"), resolveDueAt: at("2026-03-03T12:00:00"), resolvedAt: at("2026-03-03T06:00:00") }, { firstRespondedAt: at("2026-03-03T01:00:00"), resolvedByEmployeeId: a2.employeeId });
  await mk("T8", { requester: r, group: g1.id, status: "resolved", priority: "p3", createdAt: at("2026-02-20T10:00:00"), resolveDueAt: at("2026-03-01T10:00:00"), resolvedAt: at("2026-03-02T10:00:00") }, { resolvedByEmployeeId: a1.employeeId });
  await mk("T9", { requester: r, group: g1.id, status: "cancelled", createdAt: at("2026-03-08T09:00:00") });
  const t10 = await mk("T10", { requester: r, group: g1.id, status: "new", createdAt: at("2026-03-09T09:00:00"), responseDueAt: at("2026-03-09T09:15:00"), resolveDueAt: at("2026-03-09T10:00:00") });
  await prisma.ticket.update({ where: { id: t10.id }, data: { archivedAt: NOW } });
  await mk("T11", { requester: r, group: null, status: "new", priority: "p4", createdAt: at("2026-03-10T06:00:00") });
  return { g1, g2, triage, a1, a2, a3, manager, emp };
}

const summary = (a: Actor, groupId?: string, opts: object = {}) => reportSummary(prisma, a, { ...RANGE, groupId }, { now: NOW, ...opts });
const obj = <T extends Record<string, unknown>>(rows: T[], k: keyof T, v: keyof T) => Object.fromEntries(rows.map((r) => [r[k], r[v]]));

describe("numbers match the hand-computed fixture (manager: all scope)", () => {
  let s: ReportSummary;
  beforeEach(async () => { const f = await fixture(); s = await summary(f.manager); });

  it("scope and totals", () => {
    expect(s.scope).toBe("all");
    expect(s.openTotal).toBe(5); // T1 T2 T3 T4 T11; not the archived T10, the cancelled T9, or anything resolved/closed
    expect(s.createdTotal).toBe(9); // T1-T7, T9, T11 (T8 was created before the range, T10 is archived)
    expect(s.resolvedTotal).toBe(4); // T5 T6 T7 T8
  });

  it("open tickets by status, priority and group", () => {
    expect(obj(s.openByStatus, "status", "count")).toEqual({ new: 2, assigned: 1, in_progress: 1, on_hold: 1 });
    expect(obj(s.openByPriority, "priority", "count")).toEqual({ p1: 1, p2: 1, p3: 2, p4: 1 });
    expect(s.openByGroup.map((g) => [g.name, g.count])).toEqual([["Desk", 3], ["Net", 1], ["No group", 1]]);
  });

  it("created vs resolved per UTC day, with zero days present", () => {
    const d = Object.fromEntries(s.createdVsResolved.map((x) => [x.day, [x.created, x.resolved]]));
    expect(s.createdVsResolved).toHaveLength(10);
    expect(d).toEqual({
      "2026-03-01": [0, 0], "2026-03-02": [1, 1], "2026-03-03": [1, 1], "2026-03-04": [1, 1], "2026-03-05": [1, 0],
      "2026-03-06": [1, 0], "2026-03-07": [0, 1], "2026-03-08": [1, 0], "2026-03-09": [2, 0], "2026-03-10": [1, 0],
    });
  });

  it("time to resolve: 600, 1440, 360, 14400 minutes -> average 4200, median 1020", () => {
    expect(s.resolveTime).toEqual({ count: 4, avgMinutes: 4200, medianMinutes: 1020 });
  });

  it("time to first response: 30, 10, 20, 180, 60 minutes -> average 60, median 30", () => {
    expect(s.firstResponse).toEqual({ count: 5, avgMinutes: 60, medianMinutes: 30 });
  });

  it("SLA: resolution 2 of 4 met (50%); response 4 of 6 met (66.7%); 1 open ticket overdue (the paused one is not counted)", () => {
    expect(s.sla.resolve).toEqual({ met: 2, total: 4, pct: 50 });
    expect(s.sla.response).toEqual({ met: 4, total: 6, pct: 66.7 });
    expect(s.sla.breachedOpen).toBe(1);
  });

  it("backlog age and the oldest open ticket (8 days)", () => {
    expect(obj(s.backlogAge, "bucket", "count")).toEqual({ "< 1 day": 1, "1-3 days": 2, "3-7 days": 1, "7-14 days": 1, "> 14 days": 0 });
    expect(s.backlogAge.map((b) => b.bucket)).toEqual(["< 1 day", "1-3 days", "3-7 days", "7-14 days", "> 14 days"]);
    expect(s.oldestOpenDays).toBe(8);
  });

  it("per agent: the actual resolver (resolvedBy), their count and median time", () => {
    expect(s.perAgent.map((a) => [a.name, a.resolved, a.medianMinutes])).toEqual([["Alice Agent", 3, 1440], ["Bob Agent", 1, 360]]);
  });
});

describe("agents see their team only", () => {
  it("A1 (group Desk): every number is recomputed over T1 T2 T3 T5 T6 T8 T9 and never includes Net's tickets", async () => {
    const f = await fixture();
    const s = await summary(f.a1);
    expect(s.scope).toBe("team");
    expect(s.openTotal).toBe(3);
    expect(obj(s.openByStatus, "status", "count")).toEqual({ new: 1, assigned: 0, in_progress: 1, on_hold: 1 });
    expect(s.openByGroup.map((g) => g.name)).toEqual(["Desk"]);
    // created in range: T1 T2 T3 T5 T6 and the cancelled T9 = 6 (T8 was created before the range); resolved: T5 T6 T8 = 3
    expect([s.createdTotal, s.resolvedTotal]).toEqual([6, 3]);
    expect(s.resolveTime).toEqual({ count: 3, avgMinutes: 5480, medianMinutes: 1440 }); // 600, 1440, 14400
    expect(s.firstResponse).toEqual({ count: 4, avgMinutes: 60, medianMinutes: 25 }); // 30, 10, 20, 180
    expect(s.sla.resolve).toEqual({ met: 1, total: 3, pct: 33.3 });
    expect(s.sla.response).toEqual({ met: 3, total: 5, pct: 60 });
    expect(s.sla.breachedOpen).toBe(1);
    expect(s.perAgent.map((a) => a.name)).toEqual(["Alice Agent"]); // Bob resolved a Net ticket: not visible here
    expect(JSON.stringify(s)).not.toContain("Bob Agent");
  });

  it("A2 (group Net) sees only T4 and T7", async () => {
    const f = await fixture();
    const s = await summary(f.a2);
    expect([s.openTotal, s.createdTotal, s.resolvedTotal]).toEqual([1, 2, 1]);
    expect(s.resolveTime).toEqual({ count: 1, avgMinutes: 360, medianMinutes: 360 });
    expect(s.openByGroup.map((g) => g.name)).toEqual(["Net"]);
  });

  it("a triage agent also sees tickets that have no group", async () => {
    const f = await fixture();
    const s = await summary(f.a3);
    expect(s.openTotal).toBe(1); // only T11 (group-less); Tina belongs to no working group
    expect(s.openByGroup.map((g) => g.name)).toEqual(["No group"]);
  });

  it("an agent may narrow to one of their own groups, and gets 403 for anyone else's group", async () => {
    const f = await fixture();
    expect((await summary(f.a1, f.g1.id)).openTotal).toBe(3);
    await expect(summary(f.a1, f.g2.id)).rejects.toMatchObject({ status: 403 });
  });

  it("an agent does not see tickets they merely requested", async () => {
    const f = await fixture();
    await W.ticket({ requester: f.a1, group: f.g2.id, status: "new", subject: "my own laptop", createdAt: at("2026-03-09T00:00:00") });
    expect((await summary(f.a1)).openTotal).toBe(3); // unchanged: it is in Net's queue, not theirs
  });

  it("a manager can narrow to any group; the numbers are that group's", async () => {
    const f = await fixture();
    const s = await summary(f.manager, f.g2.id);
    expect([s.openTotal, s.createdTotal, s.resolvedTotal]).toEqual([1, 2, 1]);
    expect(s.perAgent.map((a) => a.name)).toEqual(["Bob Agent"]);
  });

  it("employees and submitters have no reports at all (403)", async () => {
    const f = await fixture();
    await expect(summary(f.emp)).rejects.toMatchObject({ status: 403 });
    await expect(summary(await W.actor("submitter"))).rejects.toMatchObject({ status: 403 });
  });

  it("agents see everything only with the [OPEN] view-all option", async () => {
    const f = await fixture();
    expect((await summary(f.a1, undefined, { policy: { agentsViewAllTickets: true } })).scope).toBe("all");
  });
});

describe("edge cases", () => {
  it("an empty database yields zeros and nulls, not errors", async () => {
    const m = await W.actor("manager");
    const s = await summary(m);
    expect(s.openTotal).toBe(0);
    expect(s.resolveTime).toEqual({ count: 0, avgMinutes: null, medianMinutes: null });
    expect(s.sla.resolve).toEqual({ met: 0, total: 0, pct: null });
    expect(s.oldestOpenDays).toBeNull();
    expect(s.perAgent).toEqual([]);
    expect(s.createdVsResolved).toHaveLength(10);
    expect(s.createdVsResolved.every((d) => d.created === 0 && d.resolved === 0)).toBe(true);
    expect(s.backlogAge.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it("the range bounds are [from, to): a ticket exactly at `to` is excluded, one exactly at `from` is included", async () => {
    const m = await W.actor("manager");
    const e = await W.actor("employee");
    await W.ticket({ requester: e, createdAt: at("2026-03-01T00:00:00") });
    await W.ticket({ requester: e, createdAt: at("2026-03-11T00:00:00") });
    await W.ticket({ requester: e, createdAt: at("2026-02-28T23:59:59") });
    expect((await summary(m)).createdTotal).toBe(1);
  });

  it("a ticket is counted in the day it happened in UTC, not shifted by the server's time zone", async () => {
    const m = await W.actor("manager");
    await W.ticket({ requester: await W.actor("employee"), createdAt: at("2026-03-04T23:59:59") });
    const d = (await summary(m)).createdVsResolved.find((x) => x.day === "2026-03-04")!;
    expect(d.created).toBe(1);
  });

  it("a response SLA that is not yet due and unanswered is not counted against anyone", async () => {
    const m = await W.actor("manager");
    await W.ticket({ requester: await W.actor("employee"), createdAt: at("2026-03-10T11:00:00"), responseDueAt: at("2026-03-10T13:00:00") });
    expect((await summary(m)).sla.response).toEqual({ met: 0, total: 0, pct: null });
  });

  it("median of an even count averages the middle two (interpolated)", async () => {
    const m = await W.actor("manager");
    const e = await W.actor("employee");
    for (const mins of [10, 20, 30, 100]) await W.ticket({ requester: e, status: "resolved", createdAt: at("2026-03-05T00:00:00"), resolvedAt: new Date(at("2026-03-05T00:00:00").getTime() + mins * 60_000) });
    expect((await summary(m)).resolveTime).toEqual({ count: 4, avgMinutes: 40, medianMinutes: 25 });
  });
});

describe("the SQL scope matches the access rules exactly", () => {
  it("for every role and membership, the tickets the SQL scope selects equal an independently written rule", async () => {
    const f = await fixture();
    const triageOnly = f.a3;
    const people: Array<[string, Actor, boolean]> = [["agent G1", f.a1, false], ["agent G2", f.a2, false], ["triage agent", triageOnly, false], ["manager", f.manager, false], ["agent+view-all", f.a1, true]];
    const all = await prisma.ticket.findMany({ select: { id: true, assigneeEmployeeId: true, assignmentGroupId: true, archivedAt: true } });
    for (const [label, a, viewAll] of people) {
      const policy = { agentsViewAllTickets: viewAll };
      const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT t."id" FROM "Ticket" t WHERE ${reportScopeSql(a, undefined, policy)}`);
      const expected = all.filter((t) => {
        if (t.archivedAt) return false;
        if (can(a.role, "reports.all") || viewAll) return true;
        return t.assigneeEmployeeId === a.employeeId || (t.assignmentGroupId !== null && a.groupIds.includes(t.assignmentGroupId)) || (t.assignmentGroupId === null && a.triageGroupIds.length > 0);
      }).map((t) => t.id).sort();
      expect(rows.map((r) => r.id).sort(), label).toEqual(expected);
    }
  });

  it("an agent with no groups and no assignments gets an empty scope, not everything", async () => {
    await fixture();
    const loner = await W.actor("agent");
    const s = await reportSummary(prisma, loner, RANGE, { now: NOW });
    expect([s.openTotal, s.createdTotal, s.resolvedTotal]).toEqual([0, 0, 0]);
  });
});

describe("my tickets summary (employee)", () => {
  it("counts the person's own open, waiting-for-me, to-confirm and recently closed tickets", async () => {
    const g = await W.group("Desk");
    const me = await W.actor("employee");
    const other = await W.actor("employee");
    const mk = (f: object) => W.ticket({ requester: me, group: g.id, ...f });
    await mk({ status: "new" });
    await mk({ status: "in_progress" });
    await mk({ status: "on_hold", holdReason: "awaiting_requester" });
    await mk({ status: "on_hold", holdReason: "awaiting_vendor" });
    await mk({ status: "resolved", resolvedAt: new Date() });
    const closedRecent = await mk({ status: "closed" });
    const closedOld = await mk({ status: "closed" });
    await prisma.ticket.update({ where: { id: closedRecent.id }, data: { closedAt: new Date(NOW.getTime() - 5 * 86_400_000) } });
    await prisma.ticket.update({ where: { id: closedOld.id }, data: { closedAt: new Date(NOW.getTime() - 60 * 86_400_000) } });
    await W.ticket({ requester: other, group: g.id, status: "new" }); // someone else's: never counted
    const archived = await mk({ status: "new" });
    await prisma.ticket.update({ where: { id: archived.id }, data: { archivedAt: NOW } });
    expect(await mySummary(prisma, me, NOW)).toEqual({ open: 4, awaitingMyReply: 1, resolvedToConfirm: 1, closedLast30Days: 1 });
  });

  it("tickets someone else logged for me count as mine (open), but 'awaiting my reply' and 'to confirm' need me to be the requester", async () => {
    const g = await W.group("Desk");
    const me = await W.actor("submitter");
    const jane = await W.actor("employee");
    await W.ticket({ requester: jane, createdBy: me, group: g.id, status: "new" });
    await W.ticket({ requester: jane, createdBy: me, group: g.id, status: "resolved", resolvedAt: new Date() });
    expect(await mySummary(prisma, me, NOW)).toEqual({ open: 1, awaitingMyReply: 0, resolvedToConfirm: 0, closedLast30Days: 0 });
  });
});
