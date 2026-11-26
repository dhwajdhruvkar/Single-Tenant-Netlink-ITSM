import { Prisma, type PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { ForbiddenError } from "@/platform/errors";
import { pageMeta, type SortDirection } from "@/platform/http/pagination";
import { slaStatus, type SlaLevel } from "@/modules/sla/status";
import { visibleTicketsWhere } from "./access";
import { OPEN_STATUSES } from "./stateMachine";

// Ticket lists: the four queues plus filters. Access is ALWAYS part of the database query (visibleTicketsWhere); rows are never
// fetched first and filtered in application memory.

export const VIEWS = ["mine", "visible", "assigned", "groups", "unassigned", "all", "breaching"] as const;
export type View = (typeof VIEWS)[number];
export const SORTABLE = ["createdAt", "updatedAt", "priority", "resolveDueAt"] as const;
export type SortField = (typeof SORTABLE)[number];

export const BREACHING_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SEARCH_ID_LIMIT = 2000;

export interface ListFilters {
  view: View;
  status?: string[];
  priority?: string[];
  type?: "incident" | "service_request";
  groupId?: string;
  assigneeId?: string;
  categoryId?: string;
  requesterEmployeeId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  q?: string;
}

export interface ListQuery extends ListFilters {
  page: number;
  pageSize: number;
  sortBy: SortField;
  sortDir: SortDirection;
}

export interface TicketRowDTO {
  id: string;
  reference: string;
  subject: string;
  type: string;
  status: string;
  priority: string;
  requesterName: string;
  assignmentGroup: string | null;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  resolveDueAt: string | null;
  sla: SlaLevel;
}

type Db = Pick<PrismaClient, "ticket" | "$queryRaw">;

/** Turn free text into a prefix tsquery over alphanumeric tokens only (no operators can be injected). */
export function toPrefixQuery(q: string): string | null {
  const tokens = (q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 5);
  return tokens.length ? tokens.map((t) => `${t.toLowerCase()}:*`).join(" & ") : null;
}

async function searchIds(db: Pick<PrismaClient, "$queryRaw">, q: string): Promise<string[]> {
  const ref = q.trim().toUpperCase();
  const tsq = toPrefixQuery(q);
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "Ticket"
    WHERE reference = ${ref}
       ${tsq ? Prisma.sql`OR search @@ to_tsquery('simple', ${tsq})` : Prisma.empty}
    ORDER BY ${tsq ? Prisma.sql`ts_rank(search, to_tsquery('simple', ${tsq})) DESC,` : Prisma.empty} "createdAt" DESC
    LIMIT ${SEARCH_ID_LIMIT}`);
  return rows.map((r) => r.id);
}

function viewWhere(view: View, actor: Actor, policy: PolicyOptions | undefined, now: Date): Prisma.TicketWhereInput {
  const queue = can(actor.role, "ticket.view.queue", policy);
  const all = can(actor.role, "ticket.view.all", policy);
  switch (view) {
    case "mine":
      return { OR: [{ requesterEmployeeId: actor.employeeId }, { createdByEmployeeId: actor.employeeId }] };
    case "visible":
      // Everything this actor may see (the access predicate is applied separately). Agent+ only: employees use "mine".
      if (!queue) throw new ForbiddenError();
      return {};
    case "assigned":
      if (!queue) throw new ForbiddenError();
      return { assigneeEmployeeId: actor.employeeId };
    case "groups":
      if (!queue) throw new ForbiddenError();
      return { assignmentGroupId: { in: [...actor.groupIds] } };
    case "unassigned":
      if (!queue) throw new ForbiddenError();
      // The triage queue: nobody has taken it yet. Triage members see group-less tickets; people with view-all see every untaken ticket.
      return all
        ? { assigneeEmployeeId: null, status: "new" }
        : { assigneeEmployeeId: null, status: "new", OR: [{ assignmentGroupId: null }, { assignmentGroupId: { in: [...actor.triageGroupIds] } }] };
    case "all":
      if (!all) throw new ForbiddenError();
      return {};
    case "breaching": {
      if (!queue) throw new ForbiddenError();
      const horizon = new Date(now.getTime() + BREACHING_WINDOW_MS);
      return {
        status: { in: [...OPEN_STATUSES.filter((s) => s !== "on_hold")] as never },
        slaPausedAt: null,
        OR: [{ resolveDueAt: { lte: horizon } }, { responseDueAt: { lte: horizon }, firstRespondedAt: null }],
      };
    }
  }
}

export async function listTickets(db: Db, actor: Actor, query: ListQuery, opts: { policy?: PolicyOptions; now?: Date } = {}): Promise<{ data: TicketRowDTO[]; meta: ReturnType<typeof pageMeta> }> {
  const now = opts.now ?? new Date();
  const canFilterPeople = can(actor.role, "ticket.view.queue", opts.policy);
  if ((query.requesterEmployeeId || query.assigneeId || query.groupId) && !canFilterPeople) throw new ForbiddenError();

  const and: Prisma.TicketWhereInput[] = [visibleTicketsWhere(actor, opts.policy), viewWhere(query.view, actor, opts.policy, now)];
  if (query.status?.length) and.push({ status: { in: query.status as never } });
  if (query.priority?.length) and.push({ priority: { in: query.priority as never } });
  if (query.type) and.push({ type: query.type });
  if (query.groupId) and.push({ assignmentGroupId: query.groupId });
  if (query.assigneeId) and.push({ assigneeEmployeeId: query.assigneeId });
  if (query.categoryId) and.push({ categoryId: query.categoryId });
  if (query.requesterEmployeeId) and.push({ requesterEmployeeId: query.requesterEmployeeId });
  if (query.createdFrom || query.createdTo) and.push({ createdAt: { ...(query.createdFrom ? { gte: query.createdFrom } : {}), ...(query.createdTo ? { lt: query.createdTo } : {}) } });
  if (query.q?.trim()) and.push({ id: { in: await searchIds(db, query.q) } });

  const where: Prisma.TicketWhereInput = { AND: and };
  const orderBy: Prisma.TicketOrderByWithRelationInput[] = [{ [query.sortBy]: query.sortDir }, { createdAt: "desc" }];
  const [total, rows] = await Promise.all([
    db.ticket.count({ where }),
    db.ticket.findMany({
      where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      select: {
        id: true, reference: true, subject: true, type: true, status: true, priority: true, requesterName: true, createdAt: true, updatedAt: true,
        responseDueAt: true, resolveDueAt: true, firstRespondedAt: true, resolvedAt: true, slaPausedAt: true,
        assignmentGroup: { select: { name: true } }, assignee: { select: { displayName: true } },
      },
    }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id, reference: r.reference, subject: r.subject, type: r.type, status: r.status, priority: r.priority, requesterName: r.requesterName,
      assignmentGroup: r.assignmentGroup?.name ?? null, assignee: r.assignee?.displayName ?? null,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), resolveDueAt: r.resolveDueAt?.toISOString() ?? null,
      sla: slaStatus(r, now).level,
    })),
    meta: pageMeta(total, query),
  };
}
