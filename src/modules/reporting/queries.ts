import { Prisma, type PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import type { PolicyOptions } from "@/modules/identity/permissions";
import { reportScopeOf, reportScopeSql, type ReportScope } from "./scope";

// SQL aggregates for the dashboards. Everything is computed in Postgres over the scoped ticket set; nothing is fetched and summed in
// application memory. Days are UTC days ([OPEN]: a company time zone could replace this). Durations are wall-clock minutes.

export interface ReportParams {
  /** inclusive */
  from: Date;
  /** exclusive */
  to: Date;
  groupId?: string;
}

export interface Stat {
  count: number;
  avgMinutes: number | null;
  medianMinutes: number | null;
}

export interface Compliance {
  met: number;
  total: number;
  /** percentage with one decimal, or null when there is nothing to measure */
  pct: number | null;
}

export interface ReportSummary {
  scope: ReportScope;
  range: { from: string; to: string };
  groupId: string | null;
  generatedAt: string;
  openTotal: number;
  openByStatus: { status: string; count: number }[];
  openByPriority: { priority: string; count: number }[];
  openByGroup: { groupId: string | null; name: string; count: number }[];
  createdVsResolved: { day: string; created: number; resolved: number }[];
  createdTotal: number;
  resolvedTotal: number;
  resolveTime: Stat;
  firstResponse: Stat;
  sla: { resolve: Compliance; response: Compliance; breachedOpen: number };
  backlogAge: { bucket: string; count: number }[];
  oldestOpenDays: number | null;
  perAgent: { employeeId: string; name: string; resolved: number; medianMinutes: number | null }[];
}

type Db = Pick<PrismaClient, "$queryRaw">;

const OPEN = Prisma.sql`t."status" IN ('new','assigned','in_progress','on_hold')`;
const STATUS_ORDER = ["new", "assigned", "in_progress", "on_hold"];
const PRIORITY_ORDER = ["p1", "p2", "p3", "p4"];
export const AGE_BUCKETS = ["< 1 day", "1-3 days", "3-7 days", "7-14 days", "> 14 days"] as const;
export const MAX_RANGE_DAYS = 366;

const round1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);
const pct = (met: number, total: number): number | null => (total === 0 ? null : Math.round((met / total) * 1000) / 10);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Every UTC day in [from, to), so charts show zero-days instead of gaps. */
export function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (cursor.getTime() < to.getTime() && out.length <= MAX_RANGE_DAYS + 1) {
    out.push(dayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export async function reportSummary(db: Db, actor: Actor, p: ReportParams, opts: { policy?: PolicyOptions; now?: Date } = {}): Promise<ReportSummary> {
  const now = opts.now ?? new Date();
  const scope = reportScopeOf(actor, opts.policy);
  const S = reportScopeSql(actor, p.groupId, opts.policy);
  const { from, to } = p;

  const [byStatus, byPriority, byGroup, created, resolved, resolveStat, responseStat, slaResolve, slaResponse, breached, age, agents] = await Promise.all([
    db.$queryRaw<{ k: string; n: number }[]>(Prisma.sql`SELECT t."status"::text AS k, count(*)::int AS n FROM "Ticket" t WHERE ${S} AND ${OPEN} GROUP BY 1`),
    db.$queryRaw<{ k: string; n: number }[]>(Prisma.sql`SELECT t."priority"::text AS k, count(*)::int AS n FROM "Ticket" t WHERE ${S} AND ${OPEN} GROUP BY 1`),
    db.$queryRaw<{ id: string | null; name: string | null; n: number }[]>(Prisma.sql`
      SELECT g."id" AS id, g."name" AS name, count(*)::int AS n FROM "Ticket" t LEFT JOIN "AssignmentGroup" g ON g."id" = t."assignmentGroupId"
      WHERE ${S} AND ${OPEN} GROUP BY 1, 2 ORDER BY n DESC, name ASC`),
    db.$queryRaw<{ d: Date; n: number }[]>(Prisma.sql`
      SELECT date_trunc('day', t."createdAt" AT TIME ZONE 'UTC')::date AS d, count(*)::int AS n FROM "Ticket" t
      WHERE ${S} AND t."createdAt" >= ${from} AND t."createdAt" < ${to} GROUP BY 1`),
    db.$queryRaw<{ d: Date; n: number }[]>(Prisma.sql`
      SELECT date_trunc('day', t."resolvedAt" AT TIME ZONE 'UTC')::date AS d, count(*)::int AS n FROM "Ticket" t
      WHERE ${S} AND t."resolvedAt" >= ${from} AND t."resolvedAt" < ${to} GROUP BY 1`),
    // time to resolve: tickets resolved in the range
    db.$queryRaw<{ n: number; avg: number | null; med: number | null }[]>(Prisma.sql`
      SELECT count(*)::int AS n, avg(m)::float8 AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY m)::float8 AS med FROM (
        SELECT EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0 AS m FROM "Ticket" t
        WHERE ${S} AND t."resolvedAt" >= ${from} AND t."resolvedAt" < ${to}) x`),
    // time to first response: tickets created in the range that have been answered
    db.$queryRaw<{ n: number; avg: number | null; med: number | null }[]>(Prisma.sql`
      SELECT count(*)::int AS n, avg(m)::float8 AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY m)::float8 AS med FROM (
        SELECT EXTRACT(EPOCH FROM (t."firstRespondedAt" - t."createdAt")) / 60.0 AS m FROM "Ticket" t
        WHERE ${S} AND t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t."firstRespondedAt" IS NOT NULL) x`),
    // resolution SLA: resolved in range, with a due date
    db.$queryRaw<{ total: number; met: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE t."resolvedAt" <= t."resolveDueAt")::int AS met FROM "Ticket" t
      WHERE ${S} AND t."resolvedAt" >= ${from} AND t."resolvedAt" < ${to} AND t."resolveDueAt" IS NOT NULL`),
    // response SLA: created in range, with a due date, and either answered or already overdue
    db.$queryRaw<{ total: number; met: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE t."firstRespondedAt" IS NOT NULL AND t."firstRespondedAt" <= t."responseDueAt")::int AS met FROM "Ticket" t
      WHERE ${S} AND t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t."responseDueAt" IS NOT NULL
        AND (t."firstRespondedAt" IS NOT NULL OR t."responseDueAt" <= ${now})`),
    // open tickets that are overdue right now (same rule as the UI's derived status: running clock, past a due date)
    db.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "Ticket" t WHERE ${S} AND ${OPEN} AND t."slaPausedAt" IS NULL
        AND (t."resolveDueAt" <= ${now} OR (t."firstRespondedAt" IS NULL AND t."responseDueAt" <= ${now}))`),
    db.$queryRaw<{ bucket: string; n: number; oldest: number | null }[]>(Prisma.sql`
      SELECT CASE WHEN a < 1 THEN '< 1 day' WHEN a < 3 THEN '1-3 days' WHEN a < 7 THEN '3-7 days' WHEN a < 14 THEN '7-14 days' ELSE '> 14 days' END AS bucket,
             count(*)::int AS n, max(a)::float8 AS oldest
      FROM (SELECT EXTRACT(EPOCH FROM (${now}::timestamp - t."createdAt")) / 86400.0 AS a FROM "Ticket" t WHERE ${S} AND ${OPEN}) x GROUP BY 1`),
    db.$queryRaw<{ id: string; name: string; n: number; med: number | null }[]>(Prisma.sql`
      SELECT e."id" AS id, e."displayName" AS name, count(*)::int AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")) / 60.0)::float8 AS med
      FROM "Ticket" t JOIN "Employee" e ON e."id" = t."resolvedByEmployeeId"
      WHERE ${S} AND t."resolvedAt" >= ${from} AND t."resolvedAt" < ${to}
      GROUP BY 1, 2 ORDER BY n DESC, name ASC`),
  ]);

  const c = new Map(created.map((r) => [dayKey(r.d), r.n]));
  const r = new Map(resolved.map((x) => [dayKey(x.d), x.n]));
  const days = daysBetween(from, to);
  const stat = (x: { n: number; avg: number | null; med: number | null }): Stat => ({ count: x.n, avgMinutes: round1(x.avg), medianMinutes: round1(x.med) });
  const compliance = (x: { total: number; met: number }): Compliance => ({ met: x.met, total: x.total, pct: pct(x.met, x.total) });
  const byKey = (rows: { k: string; n: number }[]) => new Map(rows.map((x) => [x.k, x.n]));
  const sm = byKey(byStatus);
  const pm = byKey(byPriority);
  const ageMap = new Map(age.map((x) => [x.bucket, x.n]));
  const oldest = age.reduce<number | null>((m, x) => (x.oldest === null ? m : m === null ? x.oldest : Math.max(m, x.oldest)), null);

  return {
    scope,
    range: { from: from.toISOString(), to: to.toISOString() },
    groupId: p.groupId ?? null,
    generatedAt: now.toISOString(),
    openTotal: byStatus.reduce((s, x) => s + x.n, 0),
    openByStatus: STATUS_ORDER.map((status) => ({ status, count: sm.get(status) ?? 0 })),
    openByPriority: PRIORITY_ORDER.map((priority) => ({ priority, count: pm.get(priority) ?? 0 })),
    openByGroup: byGroup.map((g) => ({ groupId: g.id, name: g.name ?? "No group", count: g.n })),
    createdVsResolved: days.map((day) => ({ day, created: c.get(day) ?? 0, resolved: r.get(day) ?? 0 })),
    createdTotal: created.reduce((s, x) => s + x.n, 0),
    resolvedTotal: resolved.reduce((s, x) => s + x.n, 0),
    resolveTime: stat(resolveStat[0]),
    firstResponse: stat(responseStat[0]),
    sla: { resolve: compliance(slaResolve[0]), response: compliance(slaResponse[0]), breachedOpen: breached[0].n },
    backlogAge: AGE_BUCKETS.map((bucket) => ({ bucket, count: ageMap.get(bucket) ?? 0 })),
    oldestOpenDays: round1(oldest),
    perAgent: agents.map((a) => ({ employeeId: a.id, name: a.name, resolved: a.n, medianMinutes: round1(a.med) })),
  };
}

/** The signed-in person's own tickets at a glance (the employee dashboard). */
export async function mySummary(db: Pick<PrismaClient, "ticket">, actor: Actor, now: Date = new Date()) {
  const mine: Prisma.TicketWhereInput = { archivedAt: null, OR: [{ requesterEmployeeId: actor.employeeId }, { createdByEmployeeId: actor.employeeId }] };
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [open, awaitingMe, toConfirm, closed30] = await Promise.all([
    db.ticket.count({ where: { ...mine, status: { in: ["new", "assigned", "in_progress", "on_hold"] } } }),
    db.ticket.count({ where: { archivedAt: null, requesterEmployeeId: actor.employeeId, status: "on_hold", holdReason: "awaiting_requester" } }),
    db.ticket.count({ where: { archivedAt: null, requesterEmployeeId: actor.employeeId, status: "resolved" } }),
    db.ticket.count({ where: { ...mine, status: "closed", closedAt: { gte: since } } }),
  ]);
  return { open, awaitingMyReply: awaitingMe, resolvedToConfirm: toConfirm, closedLast30Days: closed30 };
}
