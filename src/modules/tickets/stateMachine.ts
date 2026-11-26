import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { canViewTicket, type TicketAccessFacts } from "@/modules/identity/policies";
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from "@/platform/errors";

export const STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];
export const HOLD_REASONS = ["awaiting_requester", "awaiting_vendor", "awaiting_change", "scheduled", "other"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Allowed transitions (docs/planning/IMPLEMENTATION_ROADMAP.md, Phase 7). `assigned` is only reached through the assignment operations. */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  new: ["assigned", "in_progress", "on_hold", "resolved", "cancelled"],
  assigned: ["in_progress", "on_hold", "resolved", "cancelled"],
  in_progress: ["assigned", "on_hold", "resolved", "cancelled"],
  on_hold: ["assigned", "in_progress", "resolved", "cancelled"],
  resolved: ["in_progress", "closed"],
  closed: [],
  cancelled: [],
};

export const TERMINAL: readonly Status[] = ["closed", "cancelled"];
export const OPEN_STATUSES: readonly Status[] = ["new", "assigned", "in_progress", "on_hold"];

export function isAllowedTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionFacts extends TicketAccessFacts {
  status: Status;
  resolvedAt: Date | null;
}

export interface TransitionContext {
  now: Date;
  reopenWindowDays: number;
  policy?: PolicyOptions;
}

const isRequester = (actor: Actor, t: TicketAccessFacts) => t.requesterEmployeeId === actor.employeeId;
const isRequesterOrCreator = (actor: Actor, t: TicketAccessFacts) => isRequester(actor, t) || t.createdByEmployeeId === actor.employeeId;

/**
 * May `actor` move this ticket to `to`? Throws NotFound (cannot see it), Conflict (illegal transition) or Forbidden. Rules:
 *  - in_progress / on_hold / resolved: agent+ (who can see the ticket);
 *  - resolved -> closed: the requester confirms, or agent+;
 *  - resolved -> in_progress (reopen): the requester within the reopen window, or agent+ any time;
 *  - cancelled: the requester/creator while the ticket is still `new`, or agent+ from any non-terminal state.
 */
export function assertCanTransition(actor: Actor, t: TransitionFacts, to: Status, ctx: TransitionContext): void {
  if (!canViewTicket(actor, t, ctx.policy)) throw new NotFoundError();
  if (!isAllowedTransition(t.status, to)) throw new ConflictError(`A ${t.status.replace("_", " ")} ticket cannot become ${to.replace("_", " ")}.`, { code: "ILLEGAL_TRANSITION", from: t.status, to });

  const agent = can(actor.role, "ticket.update", ctx.policy);

  switch (to) {
    case "assigned":
      throw new UnprocessableError("USE_ASSIGNMENT", "Use the assignment action to assign a ticket.");
    case "in_progress":
      if (t.status === "resolved") {
        // reopen
        if (agent) return;
        if (!isRequester(actor, t)) throw new ForbiddenError();
        const windowMs = ctx.reopenWindowDays * 24 * 60 * 60 * 1000;
        if (!t.resolvedAt || ctx.now.getTime() - t.resolvedAt.getTime() > windowMs) {
          throw new ConflictError(`The ticket can only be reopened within ${ctx.reopenWindowDays} days of being resolved.`, { code: "REOPEN_WINDOW_EXPIRED" });
        }
        return;
      }
      if (!agent) throw new ForbiddenError();
      return;
    case "on_hold":
      if (!agent) throw new ForbiddenError();
      return;
    case "resolved":
      if (!can(actor.role, "ticket.resolve", ctx.policy)) throw new ForbiddenError();
      return;
    case "closed":
      if (can(actor.role, "ticket.close", ctx.policy)) return;
      if (isRequester(actor, t)) return; // the requester confirms the resolution
      throw new ForbiddenError();
    case "cancelled":
      if (can(actor.role, "ticket.escalate", ctx.policy) && agent) return;
      if (isRequesterOrCreator(actor, t) && t.status === "new") return;
      throw new ForbiddenError(isRequesterOrCreator(actor, t) ? "A ticket can only be cancelled by its requester while it is still new." : undefined);
  }
}
