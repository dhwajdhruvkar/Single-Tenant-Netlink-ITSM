import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import type { PolicyOptions } from "@/modules/identity/permissions";
import { visibleTicketsWhere } from "./access";

type Db = Pick<PrismaClient, "ticket" | "category" | "assignmentGroup" | "attachment">;

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

/** The last tickets for a given requester that THIS actor is allowed to see (used to avoid duplicates in the assisted form). */
export async function listRecentForRequester(db: Pick<Db, "ticket">, actor: Actor, requesterEmployeeId: string, limit = 5, options: PolicyOptions = {}): Promise<TicketListItem[]> {
  return db.ticket.findMany({
    where: { AND: [visibleTicketsWhere(actor, options), { requesterEmployeeId }] },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: listSelect,
  });
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
