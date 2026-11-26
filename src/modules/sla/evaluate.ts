import { Prisma, type PrismaClient } from "@prisma/client";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import { AT_RISK_FRACTION } from "./status";

// Background SLA evaluation. It only sends signals (a "breached" marker, events, notification jobs); the SLA status shown in the UI is
// always derived from the timestamps on read (sla/status.ts), so a missed or late run never shows wrong data.

export interface SlaEvaluateResult {
  responseBreached: number;
  resolveBreached: number;
  warnings: number;
}

type Db = Pick<PrismaClient, "$transaction" | "$queryRaw" | "ticket">;
const RUNNING = ["new", "assigned", "in_progress", "on_hold"] as const; // on_hold only counts while the clock is NOT paused (slaPausedAt null)

/** Mark newly breached tickets once, record the event, and enqueue notify.sla_breached (resolve breaches also flag an escalation). */
export async function evaluateSla(db: Db, now: Date, limit = 500): Promise<SlaEvaluateResult> {
  const result: SlaEvaluateResult = { responseBreached: 0, resolveBreached: 0, warnings: 0 };

  for (const kind of ["response", "resolve"] as const) {
    const where: Prisma.TicketWhereInput =
      kind === "response"
        ? { status: { in: [...RUNNING] }, slaPausedAt: null, archivedAt: null, firstRespondedAt: null, responseBreachedAt: null, responseDueAt: { lte: now } }
        : { status: { in: [...RUNNING] }, slaPausedAt: null, archivedAt: null, resolveBreachedAt: null, resolveDueAt: { lte: now } };
    const due = await db.ticket.findMany({ where, take: limit, orderBy: kind === "response" ? { responseDueAt: "asc" } : { resolveDueAt: "asc" }, select: { id: true } });

    for (const t of due) {
      await db.$transaction(async (tx) => {
        // The conditional update makes this once-only even with several runners.
        const marked = await tx.ticket.updateMany({
          where: { id: t.id, [kind === "response" ? "responseBreachedAt" : "resolveBreachedAt"]: null },
          data: kind === "response" ? { responseBreachedAt: now } : { resolveBreachedAt: now },
        });
        if (marked.count !== 1) return;
        await tx.ticketEvent.create({ data: { ticketId: t.id, type: "sla_breached", actorEmployeeId: null, toValue: kind, data: { kind } } });
        await enqueueJobs(tx, [{ kind: "notify.sla_breached", dedupeKey: `${t.id}:breach:${kind}`, payload: { ticketId: t.id, kind, escalate: kind === "resolve" } }]);
        if (kind === "response") result.responseBreached += 1;
        else result.resolveBreached += 1;
      });
    }
  }

  // Warnings: >= 75% of the window elapsed and not yet breached. Once-only through the job's dedupe key.
  for (const kind of ["response", "resolve"] as const) {
    const rows =
      kind === "response"
        ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT "id" FROM "Ticket"
            WHERE "status" IN ('new','assigned','in_progress','on_hold') AND "slaPausedAt" IS NULL AND "archivedAt" IS NULL
              AND "firstRespondedAt" IS NULL AND "responseBreachedAt" IS NULL AND "responseDueAt" > ${now}
              AND ${now} >= "createdAt" + ("responseDueAt" - "createdAt") * ${AT_RISK_FRACTION}
            LIMIT ${limit}`)
        : await db.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT "id" FROM "Ticket"
            WHERE "status" IN ('new','assigned','in_progress','on_hold') AND "slaPausedAt" IS NULL AND "archivedAt" IS NULL
              AND "resolveBreachedAt" IS NULL AND "resolveDueAt" > ${now}
              AND ${now} >= "createdAt" + ("resolveDueAt" - "createdAt") * ${AT_RISK_FRACTION}
            LIMIT ${limit}`);
    for (const r of rows) {
      const key = `${r.id}:warn:${kind}`;
      const exists = await db.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT 1 AS n FROM "Job" WHERE "dedupeKey" = ${key} LIMIT 1`);
      if (exists.length > 0) continue;
      await db.$transaction((tx) => enqueueJobs(tx, [{ kind: "notify.sla_warning", dedupeKey: key, payload: { ticketId: r.id, kind } }]));
      result.warnings += 1;
    }
  }
  return result;
}
