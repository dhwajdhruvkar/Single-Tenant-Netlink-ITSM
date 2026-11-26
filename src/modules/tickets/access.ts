import type { Prisma } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";

/**
 * The SQL (Prisma `where`) form of `canViewTicket`. Lists and searches MUST use this so access is enforced in the database query,
 * never by filtering rows in memory. A parity test checks it against `canViewTicket` for every role/relationship combination.
 */
export function visibleTicketsWhere(actor: Actor, options: PolicyOptions = {}): Prisma.TicketWhereInput {
  const clauses: Prisma.TicketWhereInput[] = [{ requesterEmployeeId: actor.employeeId }, { createdByEmployeeId: actor.employeeId }];

  if (can(actor.role, "ticket.view.all", options)) return { archivedAt: null };

  if (can(actor.role, "ticket.view.queue", options)) {
    clauses.push({ assigneeEmployeeId: actor.employeeId });
    if (actor.groupIds.length > 0) clauses.push({ assignmentGroupId: { in: [...actor.groupIds] } });
    if (actor.triageGroupIds.length > 0) clauses.push({ assignmentGroupId: null });
  }
  return { archivedAt: null, OR: clauses };
}
