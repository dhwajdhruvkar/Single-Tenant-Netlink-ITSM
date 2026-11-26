import type { PrismaClient } from "@prisma/client";
import type { Actor } from "./actor";
import { UnauthenticatedError } from "@/platform/errors";
import { atLeast } from "./roleMapping";

/** Claims carried in the session JWT. Nothing else about the user is trusted from the token. */
export interface SessionClaims {
  uaid: string; // UserAccount.id
  eid: string; // Employee.id
  sv: number; // sessionVersion at sign-in
}

export type ActorDb = Pick<PrismaClient, "userAccount" | "assignmentGroupMember">;

/**
 * Re-check the account on every request (one query, plus groups for agent+): the account must exist, be active, match the
 * session version, and the employee must still be enabled/eligible. Anything else is a 401, so disabling an account or
 * bumping sessionVersion takes effect on the very next call.
 */
export async function loadActor(db: ActorDb, claims: Partial<SessionClaims> | null | undefined): Promise<Actor> {
  if (!claims?.uaid || !claims.eid || typeof claims.sv !== "number") throw new UnauthenticatedError();

  const account = await db.userAccount.findUnique({
    where: { id: claims.uaid },
    select: {
      id: true,
      employeeId: true,
      status: true,
      role: true,
      sessionVersion: true,
      employee: { select: { accountEnabled: true, isEligible: true, directoryDeletedAt: true } },
    },
  });

  if (
    !account ||
    account.status !== "active" ||
    account.employeeId !== claims.eid ||
    account.sessionVersion !== claims.sv ||
    !account.employee.accountEnabled ||
    !account.employee.isEligible ||
    account.employee.directoryDeletedAt
  ) {
    throw new UnauthenticatedError();
  }

  let groupIds: string[] = [];
  let triageGroupIds: string[] = [];
  if (atLeast(account.role, "agent")) {
    const memberships = await db.assignmentGroupMember.findMany({
      where: { employeeId: account.employeeId, group: { active: true } },
      select: { groupId: true, group: { select: { isTriage: true, active: true } } },
    });
    groupIds = memberships.map((m) => m.groupId);
    triageGroupIds = memberships.filter((m) => m.group.isTriage).map((m) => m.groupId);
  }

  return { employeeId: account.employeeId, userAccountId: account.id, role: account.role, groupIds, triageGroupIds };
}
