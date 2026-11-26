import { Prisma, type PrismaClient } from "@prisma/client";

// Auto-assignment strategies for groups (AssignmentGroup.strategy). Adapted from the reference implementation's round-robin and
// least-loaded routing, with membership in a join table and the "who can actually take work" filter applied in SQL.

type Tx = Pick<PrismaClient, "$queryRaw" | "assignmentGroupMember" | "assignmentGroup" | "ticket">;

export type Strategy = "manual" | "round_robin" | "least_loaded";
const OPEN = ["assigned", "in_progress", "on_hold"] as const;

/** Members who can take tickets: eligible, enabled, still in the directory, with an ACTIVE account of agent role or higher. */
async function candidates(tx: Pick<Tx, "assignmentGroupMember">, groupId: string): Promise<string[]> {
  const rows = await tx.assignmentGroupMember.findMany({
    where: {
      groupId,
      employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: null, account: { status: "active", role: { in: ["agent", "manager", "admin"] } } },
    },
    select: { employeeId: true },
    orderBy: { employeeId: "asc" }, // stable order so the cursor is meaningful
  });
  return rows.map((r) => r.employeeId);
}

/**
 * Next member in turn. The cursor is advanced with one atomic UPDATE ... RETURNING, so concurrent creations get different positions.
 * Disabled or ineligible members are skipped (they are not in the candidate list at all).
 */
export async function pickRoundRobin(tx: Tx, groupId: string): Promise<string | null> {
  const members = await candidates(tx, groupId);
  if (members.length === 0) return null;
  const rows = await tx.$queryRaw<{ rrCursor: number }[]>(Prisma.sql`UPDATE "AssignmentGroup" SET "rrCursor" = "rrCursor" + 1 WHERE "id" = ${groupId}::uuid RETURNING "rrCursor"`);
  const cursor = rows[0]?.rrCursor ?? 1;
  return members[(cursor - 1) % members.length];
}

/** The member with the fewest open assigned tickets; ties go to the one who has been waiting longest (lowest id as a last resort). */
export async function pickLeastLoaded(tx: Tx, groupId: string): Promise<string | null> {
  const members = await candidates(tx, groupId);
  if (members.length === 0) return null;
  const loads = await tx.ticket.groupBy({
    by: ["assigneeEmployeeId"],
    where: { assigneeEmployeeId: { in: members }, status: { in: [...OPEN] }, archivedAt: null },
    _count: { _all: true },
  });
  const load = new Map(loads.map((l) => [l.assigneeEmployeeId as string, l._count._all]));
  const last = await tx.ticket.groupBy({ by: ["assigneeEmployeeId"], where: { assigneeEmployeeId: { in: members } }, _max: { createdAt: true } });
  const lastAt = new Map(last.map((l) => [l.assigneeEmployeeId as string, l._max.createdAt?.getTime() ?? 0]));
  return [...members].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || (lastAt.get(a) ?? 0) - (lastAt.get(b) ?? 0) || (a < b ? -1 : 1))[0];
}

/** The assignee this group's strategy would choose for a new ticket, or null for manual groups / groups with nobody available. */
export async function autoAssignee(tx: Tx, groupId: string | null): Promise<string | null> {
  if (!groupId) return null;
  const g = await tx.assignmentGroup.findUnique({ where: { id: groupId }, select: { strategy: true, active: true } });
  if (!g?.active) return null;
  if (g.strategy === "round_robin") return pickRoundRobin(tx, groupId);
  if (g.strategy === "least_loaded") return pickLeastLoaded(tx, groupId);
  return null;
}
