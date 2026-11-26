import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { visibleTicketsWhere } from "@/modules/tickets/access";
import { ForbiddenError, UnprocessableError } from "@/platform/errors";
import { CSV_BOM, csvRow } from "./csv";

export const MAX_EXPORT_ROWS = 50_000;
const PAGE = 1000;

export interface ExportFilters {
  from: Date;
  to: Date;
  groupId?: string;
  status?: string;
}

export const EXPORT_COLUMNS = [
  "Reference", "Type", "Status", "Priority", "Subject", "Category", "Group", "Assignee", "Requester", "Created by", "Channel",
  "Created (UTC)", "First response (UTC)", "Resolved (UTC)", "Closed (UTC)", "Response due (UTC)", "Resolution due (UTC)", "Resolution SLA met",
] as const;

type Db = Pick<PrismaClient, "ticket">;

function whereFor(actor: Actor, f: ExportFilters, policy?: PolicyOptions): Prisma.TicketWhereInput {
  if (!can(actor.role, "reports.all", policy)) throw new ForbiddenError();
  return {
    AND: [
      visibleTicketsWhere(actor, policy),
      { createdAt: { gte: f.from, lt: f.to } },
      ...(f.groupId ? [{ assignmentGroupId: f.groupId }] : []),
      ...(f.status ? [{ status: f.status as never }] : []),
    ],
  };
}

/** How many rows an export would contain. Refuses (422) when it is more than the cap, before anything is streamed. */
export async function countExport(db: Db, actor: Actor, f: ExportFilters, policy?: PolicyOptions): Promise<number> {
  const n = await db.ticket.count({ where: whereFor(actor, f, policy) });
  if (n > MAX_EXPORT_ROWS) throw new UnprocessableError("EXPORT_TOO_LARGE", `This export has ${n} tickets; the limit is ${MAX_EXPORT_ROWS}. Narrow the date range or pick a group.`);
  return n;
}

/**
 * Stream the CSV in pages (keyset pagination on the ticket number), so memory use stays flat whatever the size. The same access
 * predicate as the ticket lists applies, and every text cell goes through the formula-injection guard.
 */
export async function* exportTicketsCsv(db: Db, actor: Actor, f: ExportFilters, policy?: PolicyOptions): AsyncGenerator<string> {
  const where = whereFor(actor, f, policy);
  yield CSV_BOM + csvRow([...EXPORT_COLUMNS]);
  let cursor: bigint | undefined;
  let sent = 0;
  while (sent < MAX_EXPORT_ROWS) {
    const rows = await db.ticket.findMany({
      where: cursor === undefined ? where : { AND: [where, { number: { gt: cursor } }] },
      orderBy: { number: "asc" },
      take: Math.min(PAGE, MAX_EXPORT_ROWS - sent),
      select: {
        number: true, reference: true, type: true, status: true, priority: true, subject: true, channel: true, createdAt: true, firstRespondedAt: true,
        resolvedAt: true, closedAt: true, responseDueAt: true, resolveDueAt: true, requesterName: true,
        category: { select: { name: true } }, assignmentGroup: { select: { name: true } },
        assignee: { select: { displayName: true } }, createdBy: { select: { displayName: true } },
      },
    });
    if (rows.length === 0) return;
    let chunk = "";
    for (const t of rows) {
      chunk += csvRow([
        t.reference, t.type, t.status, t.priority, t.subject, t.category?.name, t.assignmentGroup?.name, t.assignee?.displayName, t.requesterName,
        t.createdBy.displayName, t.channel, t.createdAt, t.firstRespondedAt, t.resolvedAt, t.closedAt, t.responseDueAt, t.resolveDueAt,
        t.resolvedAt && t.resolveDueAt ? (t.resolvedAt <= t.resolveDueAt ? "yes" : "no") : "",
      ]);
    }
    yield chunk;
    sent += rows.length;
    cursor = rows[rows.length - 1].number;
    if (rows.length < PAGE) return;
  }
}
