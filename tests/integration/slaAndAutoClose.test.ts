import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateSla } from "@/modules/sla/evaluate";
import { autoCloseResolved } from "@/modules/tickets/autoClose";
import { getTicketDetail } from "@/modules/tickets/detail";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const NOW = new Date("2026-03-04T12:00:00Z");
const m = (min: number) => new Date(NOW.getTime() + min * 60_000);
const jobs = (kind: string) => prisma.job.findMany({ where: { kind }, orderBy: { createdAt: "asc" } });

describe("evaluateSla: breaches", () => {
  it("marks a resolve breach once, records the event and enqueues one escalation-flagged job", async () => {
    const g = await W.group("Desk");
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id, status: "in_progress", createdAt: m(-300), resolveDueAt: m(-5), responseDueAt: m(-200) });
    await prisma.ticket.update({ where: { id: t.id }, data: { firstRespondedAt: m(-250) } });
    const r = await evaluateSla(prisma, NOW);
    expect(r).toMatchObject({ resolveBreached: 1, responseBreached: 0 });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).resolveBreachedAt?.toISOString()).toBe(NOW.toISOString());
    const ev = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: t.id, type: "sla_breached" } });
    expect(ev).toMatchObject({ toValue: "resolve", actorEmployeeId: null });
    const j = await jobs("notify.sla_breached");
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ dedupeKey: `${t.id}:breach:resolve` });
    expect(j[0].payload).toMatchObject({ ticketId: t.id, kind: "resolve", escalate: true });
  });

  it("a response breach is marked separately and does not escalate", async () => {
    const t = await W.ticket({ requester: await W.actor("employee"), status: "new", createdAt: m(-120), responseDueAt: m(-10), resolveDueAt: m(500) });
    expect(await evaluateSla(prisma, NOW)).toMatchObject({ responseBreached: 1, resolveBreached: 0 });
    expect((await jobs("notify.sla_breached"))[0].payload).toMatchObject({ kind: "response", escalate: false });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).responseBreachedAt).not.toBeNull();
  });

  it("is once-only: running again, or two runners at once, adds nothing", async () => {
    await W.ticket({ requester: await W.actor("employee"), status: "in_progress", createdAt: m(-300), resolveDueAt: m(-5) });
    await Promise.all([evaluateSla(prisma, NOW), evaluateSla(prisma, NOW), evaluateSla(prisma, NOW)]);
    await evaluateSla(prisma, new Date(NOW.getTime() + 600_000));
    expect(await jobs("notify.sla_breached")).toHaveLength(1);
    expect(await prisma.ticketEvent.count({ where: { type: "sla_breached" } })).toBe(1);
  });

  it("leaves alone: paused tickets, answered response deadlines, tickets not yet due, resolved/closed/cancelled, archived", async () => {
    const e = await W.actor("employee");
    const base = { requester: e, createdAt: m(-300) };
    await W.ticket({ ...base, status: "on_hold", holdReason: "awaiting_requester", slaPausedAt: m(-100), resolveDueAt: m(-50) });
    await W.ticket({ ...base, status: "in_progress", resolveDueAt: m(50) });
    for (const status of ["resolved", "closed", "cancelled"]) await W.ticket({ ...base, status, resolveDueAt: m(-50) });
    const archived = await W.ticket({ ...base, status: "in_progress", resolveDueAt: m(-50) });
    await prisma.ticket.update({ where: { id: archived.id }, data: { archivedAt: NOW } });
    const answered = await W.ticket({ ...base, status: "in_progress", responseDueAt: m(-50), resolveDueAt: m(500) });
    await prisma.ticket.update({ where: { id: answered.id }, data: { firstRespondedAt: m(-100) } });
    expect(await evaluateSla(prisma, NOW)).toMatchObject({ responseBreached: 0, resolveBreached: 0 });
    expect(await jobs("notify.sla_breached")).toHaveLength(0);
  });

  it("an on-hold ticket whose reason does NOT pause the clock still breaches", async () => {
    await W.ticket({ requester: await W.actor("employee"), status: "on_hold", holdReason: "awaiting_vendor", createdAt: m(-300), resolveDueAt: m(-5) });
    expect((await evaluateSla(prisma, NOW)).resolveBreached).toBe(1);
  });

  it("a missed background run still shows the correct SLA status in the UI (derived on read)", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: await W.actor("employee"), group: g.id, status: "in_progress", createdAt: m(-300), resolveDueAt: m(-5) });
    // nothing has run evaluateSla: no breach marker, no job
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).resolveBreachedAt).toBeNull();
    expect(await jobs("notify.sla_breached")).toHaveLength(0);
    const detail = await getTicketDetail(prisma, agent, t.reference, { now: NOW });
    expect(detail!.sla).toMatchObject({ level: "breached", resolveBreached: true });
  });
});

describe("evaluateSla: warnings", () => {
  it("warns once when 75% of the resolution window has elapsed, and not before", async () => {
    const e = await W.actor("employee");
    const early = await W.ticket({ requester: e, status: "in_progress", createdAt: m(-70), resolveDueAt: m(30) }); // 70%
    const late = await W.ticket({ requester: e, status: "in_progress", createdAt: m(-80), resolveDueAt: m(20) }); // 80%
    await prisma.ticket.updateMany({ data: { firstRespondedAt: m(-60) } });
    const r = await evaluateSla(prisma, NOW);
    expect(r.warnings).toBe(1);
    const j = await jobs("notify.sla_warning");
    expect(j.map((x) => x.dedupeKey)).toEqual([`${late.id}:warn:resolve`]);
    expect(early.id).not.toBe(late.id);
    expect((await evaluateSla(prisma, NOW)).warnings).toBe(0); // second pass: nothing new
    expect(await jobs("notify.sla_warning")).toHaveLength(1);
  });

  it("warns about an unanswered response window too, but not once it has been answered", async () => {
    const e = await W.actor("employee");
    const waiting = await W.ticket({ requester: e, status: "new", createdAt: m(-90), responseDueAt: m(10), resolveDueAt: m(1000) });
    const answered = await W.ticket({ requester: e, status: "in_progress", createdAt: m(-90), responseDueAt: m(10), resolveDueAt: m(1000) });
    await prisma.ticket.update({ where: { id: answered.id }, data: { firstRespondedAt: m(-80) } });
    await evaluateSla(prisma, NOW);
    expect((await jobs("notify.sla_warning")).map((x) => x.dedupeKey)).toEqual([`${waiting.id}:warn:response`]);
  });

  it("does not warn paused or already-breached tickets", async () => {
    const e = await W.actor("employee");
    await W.ticket({ requester: e, status: "on_hold", holdReason: "awaiting_requester", slaPausedAt: m(-5), createdAt: m(-90), resolveDueAt: m(10) });
    await W.ticket({ requester: e, status: "in_progress", createdAt: m(-200), resolveDueAt: m(-1) });
    await evaluateSla(prisma, NOW);
    expect(await jobs("notify.sla_warning")).toHaveLength(0);
  });
});

describe("auto-close", () => {
  const resolved = (requester: Awaited<ReturnType<typeof W.actor>>, resolvedAt: Date, over: object = {}) => W.ticket({ requester, status: "resolved", resolvedAt, ...over });
  const at = (iso: string) => new Date(iso);

  it("closes after 5 working days (default), skipping the weekend, as the system with event, audit and job", async () => {
    const e = await W.actor("employee");
    const t = await resolved(e, at("2026-02-25T10:00:00Z")); // Wed; +5 working days = Wed 2026-03-04 10:00
    const r = await autoCloseResolved(prisma, at("2026-03-04T10:00:01Z"));
    expect(r.closed).toBe(1);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: "closed", version: 1 });
    expect(row.closedAt?.toISOString()).toBe("2026-03-04T10:00:01.000Z");
    expect(await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: t.id } })).toMatchObject({ type: "status_changed", fromValue: "resolved", toValue: "closed", actorEmployeeId: null, data: { via: "auto_close", afterWorkingDays: 5 } });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "ticket.auto_close" } })).toMatchObject({ actorType: "job", actorEmployeeId: null, ticketId: t.id });
    expect((await jobs("notify.ticket_status_changed"))[0].payload).toMatchObject({ auto: true, to: "closed" });
  });

  it("does not close before the working-day count is reached (weekends do not count)", async () => {
    const e = await W.actor("employee");
    const t = await resolved(e, at("2026-02-27T10:00:00Z")); // Fri; 5 working days = next Fri 03-06
    expect((await autoCloseResolved(prisma, at("2026-03-05T12:00:00Z"))).closed).toBe(0); // 5 calendar days have passed, only 3 working
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("resolved");
    expect((await autoCloseResolved(prisma, at("2026-03-06T10:00:01Z"))).closed).toBe(1);
  });

  it("follows the ticket.autoCloseDays company setting", async () => {
    await prisma.companySetting.create({ data: { key: "ticket.autoCloseDays", value: 2 } });
    const t = await resolved(await W.actor("employee"), at("2026-03-02T10:00:00Z")); // Mon + 2 = Wed
    expect((await autoCloseResolved(prisma, at("2026-03-03T12:00:00Z"))).closed).toBe(0);
    expect((await autoCloseResolved(prisma, at("2026-03-04T10:00:01Z"))).closed).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("closed");
  });

  it("never touches reopened, cancelled, already closed or archived tickets", async () => {
    const e = await W.actor("employee");
    const old = at("2026-01-01T10:00:00Z");
    await W.ticket({ requester: e, status: "in_progress" }); // reopened
    await W.ticket({ requester: e, status: "cancelled" });
    await W.ticket({ requester: e, status: "closed" });
    const archived = await resolved(e, old);
    await prisma.ticket.update({ where: { id: archived.id }, data: { archivedAt: NOW } });
    expect((await autoCloseResolved(prisma, at("2026-03-04T12:00:00Z"))).closed).toBe(0);
  });

  it("a ticket reopened between the read and the write is left alone (version/status guard)", async () => {
    const e = await W.actor("employee");
    const t = await resolved(e, at("2026-01-01T10:00:00Z"));
    // simulate the race: bump version and reopen right before the job writes
    const racing = { ...prisma, ticket: { ...prisma.ticket, findMany: async (a: never) => { const rows = await prisma.ticket.findMany(a); await prisma.ticket.update({ where: { id: t.id }, data: { status: "in_progress", version: { increment: 1 } } }); return rows; } } } as unknown as typeof prisma;
    expect((await autoCloseResolved(racing, at("2026-03-04T12:00:00Z"))).closed).toBe(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("in_progress");
  });

  it("two runners at once close each ticket exactly once", async () => {
    const e = await W.actor("employee");
    for (let i = 0; i < 5; i++) await resolved(e, at("2026-01-01T10:00:00Z"));
    const rs = await Promise.all([autoCloseResolved(prisma, at("2026-03-04T12:00:00Z")), autoCloseResolved(prisma, at("2026-03-04T12:00:00Z"))]);
    expect(rs[0].closed + rs[1].closed).toBe(5);
    expect(await prisma.ticketEvent.count({ where: { type: "status_changed" } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: "ticket.auto_close" } })).toBe(5);
  });
});
