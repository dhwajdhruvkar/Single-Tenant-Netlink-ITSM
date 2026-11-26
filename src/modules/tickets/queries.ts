import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import type { PolicyOptions } from "@/modules/identity/permissions";
import { visibleTicketsWhere } from "./access";

type Db = Pick<PrismaClient, "ticket" | "category" | "assignmentGroup">;

export interface TicketListItem {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  type: string;
  requesterName: string;
  createdAt: Date;
}

const listSelect = { id: true, reference: true, subject: true, status: true, priority: true, type: true, requesterName: true, createdAt: true } satisfies Prisma.TicketSelect;

export interface CategoryOption {
  id: string;
  name: string;
  ticketTypes: ("incident" | "service_request")[];
}

/** Active categories usable for a ticket type (an empty ticketTypes list means "all types"). */
export async function listCategoriesFor(db: Pick<Db, "category">, type: "incident" | "service_request"): Promise<CategoryOption[]> {
  const all = await db.category.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, ticketTypes: true } });
  return all.filter((c) => c.ticketTypes.length === 0 || c.ticketTypes.includes(type));
}

/** Tickets the actor filed for themselves or created for others. Minimal list; the full explorer arrives in Phase 7. */
export async function listMyTickets(db: Pick<Db, "ticket">, actor: Actor, limit = 50): Promise<TicketListItem[]> {
  return db.ticket.findMany({
    where: { archivedAt: null, OR: [{ requesterEmployeeId: actor.employeeId }, { createdByEmployeeId: actor.employeeId }] },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: listSelect,
  });
}

/** The last tickets for a given requester that THIS actor is allowed to see (used to avoid duplicates in the assisted form). */
export async function listRecentForRequester(db: Pick<Db, "ticket">, actor: Actor, requesterEmployeeId: string, limit = 5, options: PolicyOptions = {}): Promise<TicketListItem[]> {
  return db.ticket.findMany({
    where: { AND: [visibleTicketsWhere(actor, options), { requesterEmployeeId }] },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: listSelect,
  });
}

export interface TicketSummary extends TicketListItem {
  description: string;
  impact: string;
  urgency: string;
  channel: string;
  createdByName: string;
  assignmentGroup: string | null;
  assignee: string | null;
  responseDueAt: Date | null;
  resolveDueAt: Date | null;
}

/** A ticket by reference, only if the actor may see it (otherwise null => 404; existence is never revealed). */
export async function getTicketSummaryForViewer(db: Pick<Db, "ticket">, actor: Actor, reference: string, options: PolicyOptions = {}): Promise<TicketSummary | null> {
  const t = await db.ticket.findFirst({
    where: { AND: [visibleTicketsWhere(actor, options), { reference }] },
    select: { ...listSelect, description: true, impact: true, urgency: true, channel: true, responseDueAt: true, resolveDueAt: true, createdBy: { select: { displayName: true } }, assignmentGroup: { select: { name: true } }, assignee: { select: { displayName: true } } },
  });
  if (!t) return null;
  const { createdBy, assignmentGroup, assignee, ...rest } = t;
  return { ...rest, createdByName: createdBy.displayName, assignmentGroup: assignmentGroup?.name ?? null, assignee: assignee?.displayName ?? null };
}

export interface GroupOption {
  id: string;
  name: string;
  members: { id: string; displayName: string }[];
}

/** Active groups with their active members, for the agent-only fields of the assisted form. */
export async function listGroupsWithMembers(db: Pick<Db, "assignmentGroup">): Promise<GroupOption[]> {
  const groups = await db.assignmentGroup.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, members: { where: { employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: null } }, select: { employee: { select: { id: true, displayName: true } } } } },
  });
  return groups.map((g) => ({ id: g.id, name: g.name, members: g.members.map((m) => m.employee).sort((a, b) => a.displayName.localeCompare(b.displayName)) }));
}
