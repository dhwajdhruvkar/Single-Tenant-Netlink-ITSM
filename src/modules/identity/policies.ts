import type { Actor } from "./actor";
import { can, type PolicyOptions } from "./permissions";
import { atLeast } from "./roleMapping";

export interface TicketAccessFacts {
  requesterEmployeeId: string;
  createdByEmployeeId: string;
  assigneeEmployeeId: string | null;
  assignmentGroupId: string | null;
}

/**
 * Record-level visibility (Doc C section 3.2): the actor is the requester, OR the creator, OR holds ticket.view.all, OR is an
 * agent and (assignee is the actor, OR the ticket's group is one of theirs, OR the ticket has no group and the actor is in a
 * triage group).
 */
export function canViewTicket(actor: Actor, t: TicketAccessFacts, options: PolicyOptions = {}): boolean {
  if (t.requesterEmployeeId === actor.employeeId) return true;
  if (t.createdByEmployeeId === actor.employeeId) return true;
  if (can(actor.role, "ticket.view.all", options)) return true;
  if (!can(actor.role, "ticket.view.queue", options)) return false;
  if (t.assigneeEmployeeId === actor.employeeId) return true;
  if (t.assignmentGroupId !== null) return actor.groupIds.includes(t.assignmentGroupId);
  return actor.triageGroupIds.length > 0;
}

/** Internal notes (and their attachments) need an agent-or-higher role AND visibility of the ticket. */
export function canViewInternal(actor: Actor, t: TicketAccessFacts, options: PolicyOptions = {}): boolean {
  return atLeast(actor.role, "agent") && canViewTicket(actor, t, options);
}
