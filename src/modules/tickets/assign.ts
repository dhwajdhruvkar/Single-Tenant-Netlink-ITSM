import { z } from "zod";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from "@/platform/errors";
import { auditOf, applyVersioned, loadVisibleTicket, recordEvent, resultOf, type OpsContext, type OpsDeps, type TicketResultDTO } from "./ops";
import { OPEN_STATUSES, type Status } from "./stateMachine";

export const Assignment = z
  .object({
    version: z.number().int().min(0),
    groupId: z.string().uuid().optional(),
    /** a person's id, "me", or null to unassign; omit to leave the assignee unchanged */
    assigneeEmployeeId: z.union([z.string().uuid(), z.literal("me"), z.null()]).optional(),
  })
  .strict();
export type AssignmentInput = z.infer<typeof Assignment>;

const eligibleMember = { employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: null } } as const;

/**
 * Assign a ticket to a group and/or person.
 *  - Agents may take a ticket for themselves or assign to a member of a group they belong to; managers/admins may assign to any member
 *    of the target group.
 *  - The assignee must be an active, eligible member of the resulting group (or of a triage group if the ticket has no group).
 *  - `assigned` follows the assignee: new -> assigned when one is set, assigned -> new when cleared.
 * Two agents taking the same ticket send the same version: exactly one succeeds, the other gets 409 STALE_VERSION.
 */
export async function assignTicket(deps: OpsDeps, actor: Actor, reference: string, input: AssignmentInput, ctx: OpsContext = {}): Promise<TicketResultDTO> {
  if (input.groupId === undefined && input.assigneeEmployeeId === undefined) throw new ValidationError("Nothing to change.");
  const audit = auditOf(deps);

  return deps.db.$transaction(async (tx) => {
    const t = await loadVisibleTicket(tx, actor, reference, deps.policy);
    if (!can(actor.role, "ticket.assign.self", deps.policy)) throw new ForbiddenError();
    if (!OPEN_STATUSES.includes(t.status as Status)) throw new ConflictError("Only open tickets can be assigned.", { code: "TICKET_NOT_OPEN" });

    const manager = can(actor.role, "ticket.reassign.any", deps.policy);
    if (input.groupId !== undefined && !can(actor.role, "ticket.reassign.group", deps.policy)) throw new ForbiddenError();

    // --- resulting group ---------------------------------------------------------------------------------------------
    let groupId = t.assignmentGroupId;
    if (input.groupId !== undefined && input.groupId !== t.assignmentGroupId) {
      const g = await tx.assignmentGroup.findFirst({ where: { id: input.groupId, active: true }, select: { id: true } });
      if (!g) throw new UnprocessableError("GROUP_INVALID", "The selected group is not available.");
      groupId = g.id;
    }

    // --- resulting assignee ------------------------------------------------------------------------------------------
    let assignee: string | null = t.assigneeEmployeeId;
    const requested = input.assigneeEmployeeId === "me" ? actor.employeeId : input.assigneeEmployeeId;
    if (requested !== undefined) assignee = requested;

    const groupChanged = groupId !== t.assignmentGroupId;
    if (requested === undefined && groupChanged && assignee) {
      // moving the ticket to another group keeps the assignee only if they belong to it
      const stillMember = await tx.assignmentGroupMember.findFirst({ where: { groupId: groupId!, employeeId: assignee, ...eligibleMember }, select: { employeeId: true } });
      if (!stillMember) assignee = null;
    }

    if (assignee && assignee !== t.assigneeEmployeeId) {
      const isSelf = assignee === actor.employeeId;
      const inGroup = groupId
        ? await tx.assignmentGroupMember.findFirst({ where: { groupId, employeeId: assignee, ...eligibleMember }, select: { employeeId: true } })
        : await tx.assignmentGroupMember.findFirst({ where: { employeeId: assignee, group: { isTriage: true, active: true }, ...eligibleMember }, select: { employeeId: true } });
      if (!inGroup) throw new UnprocessableError("ASSIGNEE_NOT_IN_GROUP", "The assignee must be an active member of the ticket's group.");
      if (!manager && !actor.groupIds.includes(groupId ?? "") && !(isSelf && groupId === null && actor.triageGroupIds.length > 0)) {
        throw new ForbiddenError("You can only assign tickets within groups you belong to.");
      }
    }

    const assigneeChanged = assignee !== t.assigneeEmployeeId;
    if (!assigneeChanged && !groupChanged) throw new ValidationError("Nothing to change.");

    let status = t.status as Status;
    if (assignee && status === "new") status = "assigned";
    else if (!assignee && status === "assigned") status = "new";

    const updated = await applyVersioned(tx, t, input.version, { assignmentGroupId: groupId, assigneeEmployeeId: assignee, status });

    if (groupChanged) await recordEvent(tx, { ticketId: t.id, type: "group_changed", actorEmployeeId: actor.employeeId, fromValue: t.assignmentGroupId, toValue: groupId });
    if (assigneeChanged) await recordEvent(tx, { ticketId: t.id, type: "assigned", actorEmployeeId: actor.employeeId, fromValue: t.assigneeEmployeeId, toValue: assignee });
    if (status !== t.status) await recordEvent(tx, { ticketId: t.id, type: "status_changed", actorEmployeeId: actor.employeeId, fromValue: t.status, toValue: status, data: { via: "assignment" } });
    await audit(tx, {
      action: "ticket.assign", actorType: "user", actorEmployeeId: actor.employeeId, entityType: "ticket", entityId: t.id, ticketId: t.id, requestId: ctx.requestId,
      changes: { ...(groupChanged ? { assignmentGroupId: [t.assignmentGroupId, groupId] } : {}), ...(assigneeChanged ? { assigneeEmployeeId: [t.assigneeEmployeeId, assignee] } : {}) },
    });
    await enqueueJobs(tx, [{ kind: "notify.ticket_assigned", dedupeKey: `${t.id}:v${updated.version}:assigned`, payload: { ticketId: t.id, assignmentGroupId: groupId, assigneeEmployeeId: assignee } }]);
    return resultOf(updated);
  });
}
