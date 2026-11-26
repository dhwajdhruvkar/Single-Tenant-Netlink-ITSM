import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import { enqueueJobs } from "@/modules/jobs/enqueue";

// Resolved tickets that nobody reopened are closed by the system after `ticket.autoCloseDays` working days ([OPEN], default 5).

/**
 * Add whole working days (Monday to Friday, UTC). [OPEN]: the company's time zone and holidays are not applied; a business calendar
 * could replace this later. Landing on a weekend moves to the next Monday only through the counting, never by skipping the time of day.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export interface AutoCloseResult {
  closed: number;
}

type Db = Pick<PrismaClient, "ticket" | "companySetting" | "$transaction">;

export async function autoCloseResolved(db: Db, now: Date, limit = 200): Promise<AutoCloseResult> {
  const setting = await db.companySetting.findUnique({ where: { key: "ticket.autoCloseDays" } });
  const days = typeof setting?.value === "number" && setting.value >= 0 ? setting.value : 5;

  // Cheap lower bound in SQL (calendar days), exact working-day check below. The candidate set (resolved, not closed) is small.
  const candidates = await db.ticket.findMany({
    where: { status: "resolved", archivedAt: null, resolvedAt: { lte: new Date(now.getTime() - days * 86_400_000) } },
    orderBy: { resolvedAt: "asc" },
    take: limit,
    select: { id: true, version: true, resolvedAt: true },
  });

  let closed = 0;
  for (const t of candidates) {
    if (!t.resolvedAt || addWorkingDays(t.resolvedAt, days).getTime() > now.getTime()) continue;
    const ok = await db.$transaction(async (tx) => {
      // status + version in the condition: a ticket reopened (or closed by someone) in the meantime is left alone
      const r = await tx.ticket.updateMany({ where: { id: t.id, status: "resolved", version: t.version }, data: { status: "closed", closedAt: now, version: { increment: 1 } } });
      if (r.count !== 1) return false;
      await tx.ticketEvent.create({ data: { ticketId: t.id, type: "status_changed", actorEmployeeId: null, fromValue: "resolved", toValue: "closed", data: { via: "auto_close", afterWorkingDays: days } } });
      await writeAudit(tx, { action: "ticket.auto_close", actorType: "job", entityType: "ticket", entityId: t.id, ticketId: t.id, changes: { status: ["resolved", "closed"] } });
      await enqueueJobs(tx, [{ kind: "notify.ticket_status_changed", dedupeKey: `${t.id}:v${t.version + 1}:status`, payload: { ticketId: t.id, from: "resolved", to: "closed", auto: true } }]);
      return true;
    });
    if (ok) closed += 1;
  }
  return { closed };
}
