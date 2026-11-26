import type { PrismaClient } from "@prisma/client";
import { atLeast, type AppRole } from "@/modules/identity/roleMapping";

export interface Person {
  employeeId: string;
  displayName: string;
  email: string | null;
  role: AppRole;
  /** The "email me" preference. [OPEN] default on: only an explicit `emailNotifications: false` turns it off. */
  emailOptIn: boolean;
}

type Db = Pick<PrismaClient, "employee" | "assignmentGroupMember" | "userAccount">;

/** Where a notification link should take this person: agents work in the desk, everyone else sees their own tickets. */
export function areaFor(role: AppRole): "desk" | "my" {
  return atLeast(role, "agent") ? "desk" : "my";
}

/** Only people who can still receive anything: enabled, eligible and present in the directory. Duplicates collapse. */
export async function loadPeople(db: Pick<Db, "employee">, ids: Iterable<string | null | undefined>): Promise<Person[]> {
  const unique = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return [];
  const rows = await db.employee.findMany({
    where: { id: { in: unique }, accountEnabled: true, isEligible: true, directoryDeletedAt: null },
    select: { id: true, displayName: true, mail: true, userPrincipalName: true, account: { select: { role: true, status: true, preferences: true } } },
  });
  return rows.map((r) => ({
    employeeId: r.id,
    displayName: r.displayName,
    email: r.mail ?? (r.userPrincipalName.includes("@") ? r.userPrincipalName : null),
    role: r.account?.status === "active" ? r.account.role : "employee",
    emailOptIn: (r.account?.preferences as { emailNotifications?: unknown } | null)?.emailNotifications !== false,
  }));
}

/** Members of a group who can take work (agent role or higher, active account). `leadsOnly` restricts to group leads. */
export async function groupAgentIds(db: Pick<Db, "assignmentGroupMember">, groupId: string, leadsOnly = false): Promise<string[]> {
  const rows = await db.assignmentGroupMember.findMany({
    where: { groupId, ...(leadsOnly ? { role: "lead" } : {}), employee: { account: { status: "active", role: { in: ["agent", "manager", "admin"] } } } },
    select: { employeeId: true },
  });
  return rows.map((r) => r.employeeId);
}

/** Active managers, for SLA escalation. */
export async function managerIds(db: Pick<Db, "userAccount">): Promise<string[]> {
  const rows = await db.userAccount.findMany({ where: { status: "active", role: "manager" }, select: { employeeId: true } });
  return rows.map((r) => r.employeeId);
}
