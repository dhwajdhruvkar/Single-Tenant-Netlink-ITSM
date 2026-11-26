import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import { listTickets, toPrefixQuery, type ListQuery } from "@/modules/tickets/list";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ view: "mine", page: 1, pageSize: 25, sortBy: "createdAt", sortDir: "desc", ...over });
const subjects = async (a: Actor, over: Partial<ListQuery> = {}, opts = {}) => (await listTickets(prisma, a, q(over), opts)).data.map((r) => r.subject).sort();

async function scene() {
  const mine = await W.group("Mine");
  const other = await W.group("Other");
  const triage = await W.group("Service Desk", true);
  const emp = await W.actor("employee");
  const stranger = await W.actor("employee");
  const agent = await W.actor("agent", [mine]);
  const triageAgent = await W.actor("agent", [triage]);
  const manager = await W.actor("manager");
  const t = {
    own: await W.ticket({ requester: emp, subject: "own", group: other.id }),
    created: await W.ticket({ requester: stranger, createdBy: emp, subject: "created-by-emp", group: other.id }),
    assigned: await W.ticket({ requester: stranger, subject: "assigned-to-agent", group: other.id, assignee: agent, status: "assigned" }),
    inGroup: await W.ticket({ requester: stranger, subject: "in-agent-group", group: mine.id }),
    otherGroup: await W.ticket({ requester: stranger, subject: "other-group", group: other.id }),
    noGroup: await W.ticket({ requester: stranger, subject: "no-group", group: null }),
    triageTicket: await W.ticket({ requester: stranger, subject: "in-triage-group", group: triage.id }),
  };
  return { mine, other, triage, emp, stranger, agent, triageAgent, manager, t };
}

describe("queues per role", () => {
  it("employees see only tickets they requested or created; queue views are 403", async () => {
    const s = await scene();
    expect(await subjects(s.emp)).toEqual(["created-by-emp", "own"]);
    for (const view of ["assigned", "groups", "unassigned", "all", "breaching", "visible"] as const) {
      await expect(listTickets(prisma, s.emp, q({ view }))).rejects.toMatchObject({ status: 403 });
    }
  });

  it("an agent: 'assigned' is theirs, 'groups' is their groups, 'mine' is what they requested", async () => {
    const s = await scene();
    expect(await subjects(s.agent, { view: "assigned" })).toEqual(["assigned-to-agent"]);
    expect(await subjects(s.agent, { view: "groups" })).toEqual(["in-agent-group"]);
    expect(await subjects(s.agent, { view: "mine" })).toEqual([]);
    expect(await subjects(s.agent, { view: "visible" })).toEqual(["assigned-to-agent", "in-agent-group"]); // nothing from other queues
  });

  it("the unassigned (triage) queue shows untaken tickets to triage members only", async () => {
    const s = await scene();
    expect(await subjects(s.triageAgent, { view: "unassigned" })).toEqual(["in-triage-group", "no-group"]);
    expect(await subjects(s.agent, { view: "unassigned" })).toEqual([]); // not a triage member: their own group's tickets are under "groups"
    expect((await subjects(s.manager, { view: "unassigned" })).length).toBe(6); // everything untaken
  });

  it("'all' is for view-all roles only (managers, admins; agents only with the [OPEN] option)", async () => {
    const s = await scene();
    expect((await subjects(s.manager, { view: "all" })).length).toBe(7);
    await expect(listTickets(prisma, s.agent, q({ view: "all" }))).rejects.toMatchObject({ status: 403 });
    expect((await subjects(s.agent, { view: "all" }, { policy: { agentsViewAllTickets: true } })).length).toBe(7);
  });

  it("an agent cannot widen their view with filters: groupId/assignee/requester filters only narrow what they may already see", async () => {
    const s = await scene();
    expect(await subjects(s.agent, { view: "visible", groupId: s.other.id })).toEqual(["assigned-to-agent"]); // the only visible ticket in that group
    expect(await subjects(s.agent, { view: "visible", requesterEmployeeId: s.emp.employeeId })).toEqual([]);
  });

  it("employees cannot use people filters (403)", async () => {
    const s = await scene();
    for (const f of [{ requesterEmployeeId: s.stranger.employeeId }, { assigneeId: s.agent.employeeId }, { groupId: s.other.id }]) {
      await expect(listTickets(prisma, s.emp, q(f))).rejects.toMatchObject({ status: 403 });
    }
  });

  it("archived tickets are in no list, for anyone", async () => {
    const s = await scene();
    await prisma.ticket.update({ where: { id: s.t.own.id }, data: { archivedAt: new Date() } });
    expect(await subjects(s.emp)).toEqual(["created-by-emp"]);
    expect((await subjects(s.manager, { view: "all" })).length).toBe(6);
  });
});

describe("'breaching soon'", () => {
  it("lists open, running tickets whose deadline is within two hours or past; skips paused, on-hold, resolved and distant ones", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const requester = await W.actor("employee");
    const now = new Date("2026-03-04T12:00:00Z");
    const m = (min: number) => new Date(now.getTime() + min * 60_000);
    const mk = (subject: string, o: object) => W.ticket({ requester, group: g.id, subject, ...o });
    await mk("overdue", { status: "in_progress", resolveDueAt: m(-30) });
    await mk("due-in-1h", { status: "assigned", resolveDueAt: m(60) });
    await mk("response-due-soon", { status: "new", responseDueAt: m(20), resolveDueAt: m(600) });
    await mk("distant", { status: "in_progress", resolveDueAt: m(600) });
    await mk("paused", { status: "on_hold", holdReason: "awaiting_requester", slaPausedAt: m(-10), resolveDueAt: m(10) });
    await mk("resolved", { status: "resolved", resolveDueAt: m(-10), resolvedAt: m(-20) });
    await mk("no-sla", { status: "new" });
    const r = await listTickets(prisma, agent, q({ view: "breaching" }), { now });
    expect(r.data.map((x) => x.subject).sort()).toEqual(["due-in-1h", "overdue", "response-due-soon"]);
    expect(r.data.find((x) => x.subject === "overdue")!.sla).toBe("breached");
  });
});

describe("filters", () => {
  async function many() {
    const g = await W.group("Desk");
    const g2 = await W.group("Net");
    const agent = await W.actor("agent", [g, g2]);
    const requester = await W.actor("employee");
    const cat = await prisma.category.create({ data: { name: "Network" } });
    const mk = (subject: string, o: object = {}) => W.ticket({ requester, group: g.id, subject, ...o });
    await mk("a-new-p1", { priority: "p1" });
    await mk("b-prog-p2", { status: "in_progress", priority: "p2", assignee: agent });
    await mk("c-hold-p3", { status: "on_hold", holdReason: "other", priority: "p3" });
    await mk("d-net-p4", { group: g2.id, priority: "p4", categoryId: cat.id, type: "service_request" });
    await mk("e-old", { createdAt: new Date("2026-01-10T00:00:00Z") });
    return { g, g2, agent, requester, cat };
  }

  it("filters by status, priority, type, group, assignee, category, requester and date range", async () => {
    const { g2, agent, requester, cat } = await many();
    const base = { view: "visible" as const };
    const a = agent;
    expect(await subjects(a, { ...base, status: ["in_progress", "on_hold"] })).toEqual(["b-prog-p2", "c-hold-p3"]);
    expect(await subjects(a, { ...base, priority: ["p1", "p4"] })).toEqual(["a-new-p1", "d-net-p4"]);
    expect(await subjects(a, { ...base, type: "service_request" })).toEqual(["d-net-p4"]);
    expect(await subjects(a, { ...base, groupId: g2.id })).toEqual(["d-net-p4"]);
    expect(await subjects(a, { ...base, assigneeId: agent.employeeId })).toEqual(["b-prog-p2"]);
    expect(await subjects(a, { ...base, categoryId: cat.id })).toEqual(["d-net-p4"]);
    expect((await subjects(a, { ...base, requesterEmployeeId: requester.employeeId })).length).toBe(5);
    expect(await subjects(a, { ...base, createdTo: new Date("2026-02-01T00:00:00Z") })).toEqual(["e-old"]);
    expect((await subjects(a, { ...base, createdFrom: new Date("2026-02-01T00:00:00Z") })).length).toBe(4);
  });

  it("combines filters with AND", async () => {
    const { agent } = await many();
    expect(await subjects(agent, { view: "visible", status: ["in_progress"], priority: ["p1"] })).toEqual([]);
  });
});

describe("search", () => {
  async function corpus() {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const requester = await W.actor("employee");
    const mk = (subject: string, description = "d", o: object = {}) => W.ticket({ requester, group: g.id, subject, description, ...o });
    const vpn = await mk("VPN keeps dropping", "Every hour the tunnel disconnects");
    await mk("Printer on floor 3 jammed", "Paper stuck in tray two");
    await mk("Cannot open spreadsheet", "Excel crashes with a VPNLIKE-error");
    const other = await W.actor("employee");
    await W.ticket({ requester: other, group: (await W.group("Other")).id, subject: "VPN in another queue", description: "not visible to the agent" });
    return { agent, requester, vpn };
  }

  it("finds by reference (case-insensitive), word, word prefix and description text", async () => {
    const { agent, vpn } = await corpus();
    const S = (qq: string) => subjects(agent, { view: "visible", q: qq });
    expect(await S(vpn.reference.toLowerCase())).toEqual(["VPN keeps dropping"]);
    // every term is a PREFIX match, so "vpn" also finds the word "VPNLIKE-error"
    expect(await S("vpn")).toEqual(["Cannot open spreadsheet", "VPN keeps dropping"]);
    expect(await S("vpn tunnel")).toEqual(["VPN keeps dropping"]); // all terms must match
    expect(await S("print")).toEqual(["Printer on floor 3 jammed"]); // prefix
    expect(await S("tunnel disconnects")).toEqual(["VPN keeps dropping"]); // description, all words
    expect(await S("spreadsheet excel")).toEqual(["Cannot open spreadsheet"]);
    expect(await S("zzzznothing")).toEqual([]);
  });

  it("never reveals tickets outside the viewer's access, even when they match", async () => {
    const { agent } = await corpus();
    expect(await subjects(agent, { view: "visible", q: "another queue" })).toEqual([]);
  });

  it("is safe against tsquery/SQL syntax in user text", async () => {
    const { agent } = await corpus();
    for (const evil of [`vpn' OR '1'='1`, "vpn & !", "(((", `"; DROP TABLE "Ticket"; --`, "a:*b", "!!!", "\\", "vpn | printer"]) {
      await expect(listTickets(prisma, agent, q({ view: "visible", q: evil }))).resolves.toBeDefined();
    }
    expect(await prisma.ticket.count()).toBe(4);
  });

  it("toPrefixQuery keeps only letters and digits (any script) and caps the term count", () => {
    expect(toPrefixQuery("Hello, WORLD!")).toBe("hello:* & world:*");
    expect(toPrefixQuery("a:* | b & !c")).toBe("a:* & b:* & c:*");
    expect(toPrefixQuery("  ")).toBeNull();
    expect(toPrefixQuery("!!!")).toBeNull();
    expect(toPrefixQuery("отчёт 报告")).toBe("отчёт:* & 报告:*");
    expect(toPrefixQuery("1 2 3 4 5 6 7")!.split(" & ").length).toBe(5);
  });
});

describe("pagination and sorting", () => {
  async function fifty() {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const requester = await W.actor("employee");
    const prios = ["p1", "p2", "p3", "p4"] as const;
    for (let i = 0; i < 50; i++) await W.ticket({ requester, group: g.id, subject: `t${String(i).padStart(2, "0")}`, priority: prios[i % 4], createdAt: new Date(Date.UTC(2026, 2, 1, 0, i)) });
    return agent;
  }

  it("pages are disjoint and complete; meta reports the true total", async () => {
    const agent = await fifty();
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await listTickets(prisma, agent, q({ view: "visible", page, pageSize: 20 }));
      expect(r.meta).toEqual({ total: 50, page, pageSize: 20, totalPages: 3 });
      seen.push(...r.data.map((x) => x.subject));
    }
    expect(seen.length).toBe(50);
    expect(new Set(seen).size).toBe(50);
    expect((await listTickets(prisma, agent, q({ view: "visible", page: 4, pageSize: 20 }))).data).toEqual([]);
  });

  it("sorts newest first by default, by priority (p1 first) on request, and in either direction", async () => {
    const agent = await fifty();
    const byDate = await listTickets(prisma, agent, q({ view: "visible", pageSize: 3 }));
    expect(byDate.data.map((x) => x.subject)).toEqual(["t49", "t48", "t47"]);
    const byPrio = await listTickets(prisma, agent, q({ view: "visible", pageSize: 3, sortBy: "priority", sortDir: "asc" }));
    expect(byPrio.data.every((x) => x.priority === "p1")).toBe(true);
    const lowFirst = await listTickets(prisma, agent, q({ view: "visible", pageSize: 3, sortBy: "priority", sortDir: "desc" }));
    expect(lowFirst.data.every((x) => x.priority === "p4")).toBe(true);
    const oldest = await listTickets(prisma, agent, q({ view: "visible", pageSize: 2, sortDir: "asc" }));
    expect(oldest.data.map((x) => x.subject)).toEqual(["t00", "t01"]);
  });

  it("total counts reflect filters, and the page size is honoured", async () => {
    const agent = await fifty();
    const r = await listTickets(prisma, agent, q({ view: "visible", priority: ["p1"], pageSize: 5 }));
    expect(r.meta.total).toBe(13);
    expect(r.data).toHaveLength(5);
    expect(r.meta.totalPages).toBe(3);
  });
});
