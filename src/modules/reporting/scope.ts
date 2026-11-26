import { Prisma } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { ForbiddenError } from "@/platform/errors";

// Who may see which tickets in the REPORTS.
//   all  (manager, admin; agents only with the [OPEN] view-all option): every non-archived ticket
//   team (agent): tickets assigned to them, in one of their groups, or (triage members) without a group.
//        Unlike the ticket list this deliberately EXCLUDES tickets that merely have the agent as requester/creator: a report is about the
//        team's work, not about the agent's own requests.
//   anyone else: no reports (403)

export type ReportScope = "all" | "team";

export function reportScopeOf(actor: Actor, policy?: PolicyOptions): ReportScope {
  if (can(actor.role, "reports.all", policy) || can(actor.role, "ticket.view.all", policy)) return "all";
  if (can(actor.role, "reports.team", policy)) return "team";
  throw new ForbiddenError();
}

const uuid = (ids: readonly string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

/** SQL predicate over alias `t` ("Ticket"). Archived tickets are never reported. `groupId` narrows further and must be a group the actor may report on. */
export function reportScopeSql(actor: Actor, groupId: string | undefined, policy?: PolicyOptions): Prisma.Sql {
  const scope = reportScopeOf(actor, policy);
  const parts: Prisma.Sql[] = [Prisma.sql`t."archivedAt" IS NULL`];

  if (scope === "team") {
    const own: Prisma.Sql[] = [Prisma.sql`t."assigneeEmployeeId" = ${actor.employeeId}::uuid`];
    if (actor.groupIds.length > 0) own.push(Prisma.sql`t."assignmentGroupId" IN (${uuid(actor.groupIds)})`);
    if (actor.triageGroupIds.length > 0) own.push(Prisma.sql`t."assignmentGroupId" IS NULL`);
    parts.push(Prisma.sql`(${Prisma.join(own, " OR ")})`);
    if (groupId && !actor.groupIds.includes(groupId)) throw new ForbiddenError("You can only report on your own groups.");
  }
  if (groupId) parts.push(Prisma.sql`t."assignmentGroupId" = ${groupId}::uuid`);
  return Prisma.join(parts, " AND ");
}
