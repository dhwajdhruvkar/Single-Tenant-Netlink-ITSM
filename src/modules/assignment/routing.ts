import type { PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient, "assignmentGroup">;

export type RoutingSource = "explicit" | "category" | "triage" | "none";

export interface RoutingDecision {
  groupId: string | null;
  source: RoutingSource;
}

/**
 * Where a new ticket goes: an explicit group (the caller has already checked they may choose one), else the category's default
 * group, else the active triage group. Inactive groups are never chosen implicitly. Auto-assignment strategies arrive in Phase 8.
 */
export async function routeTicket(db: Db, input: { explicitGroupId?: string | null; categoryDefaultGroupId?: string | null }): Promise<RoutingDecision> {
  if (input.explicitGroupId) return { groupId: input.explicitGroupId, source: "explicit" };

  if (input.categoryDefaultGroupId) {
    const g = await db.assignmentGroup.findFirst({ where: { id: input.categoryDefaultGroupId, active: true }, select: { id: true } });
    if (g) return { groupId: g.id, source: "category" };
  }

  const triage = await db.assignmentGroup.findFirst({ where: { isTriage: true, active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return triage ? { groupId: triage.id, source: "triage" } : { groupId: null, source: "none" };
}
