import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import type { Actor } from "@/modules/identity/actor";
import { can, type Permission } from "@/modules/identity/permissions";
import { ConflictError, ForbiddenError } from "@/platform/errors";

// Shared plumbing for the admin configuration services: permission check, audit in the same transaction, unique-violation mapping.

export interface AdminDeps {
  db: PrismaClient;
  audit?: typeof writeAudit;
}

export function assertAdmin(actor: Actor, permission: Permission = "config.manage"): void {
  if (!can(actor.role, permission)) throw new ForbiddenError();
}

const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const isCheck = (e: unknown) => e instanceof Error && /check constraint|violates check/i.test(e.message);

export async function adminWrite<T>(
  deps: AdminDeps,
  actor: Actor,
  entry: { action: string; entityType: string; entityId?: () => string | undefined; changes?: Record<string, unknown> },
  work: (tx: Prisma.TransactionClient) => Promise<{ result: T; entityId: string; changes?: Record<string, unknown> }>,
  conflictMessage: string,
  requestId?: string,
): Promise<T> {
  try {
    return await deps.db.$transaction(async (tx) => {
      const { result, entityId, changes } = await work(tx);
      await (deps.audit ?? writeAudit)(tx, { action: entry.action, actorType: "user", actorEmployeeId: actor.employeeId, entityType: entry.entityType, entityId, requestId, changes: changes ?? entry.changes ?? null });
      return result;
    });
  } catch (err) {
    if (isUnique(err)) throw new ConflictError(conflictMessage);
    if (isCheck(err)) throw new ConflictError("The values violate a database rule (for example hours that do not make sense).");
    throw err;
  }
}

/** [before, after] for every key whose value changed. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(after)) if (v !== undefined && JSON.stringify(before[k]) !== JSON.stringify(v)) out[k] = [before[k], v];
  return out;
}
