import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import { type DenialReason, type EntraClaims } from "./claims";
import { highestRole, mapEntraRoles, type AppRole, type RoleMappingConfig } from "./roleMapping";

export type SignInResult =
  | { allowed: true; userAccountId: string; employeeId: string; sessionVersion: number; role: AppRole }
  | { allowed: false; reason: DenialReason };

interface Db {
  $transaction: PrismaClient["$transaction"];
}

const PRIOR_UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === PRIOR_UNIQUE_VIOLATION;
}

/**
 * Provision/refresh the Employee + UserAccount for a validated Entra sign-in and sync Entra-sourced roles.
 * Keyed by entraObjectId (oid). Safe to call concurrently for the same person (a lost insert race retries once).
 * Every outcome writes an audit row in the same transaction.
 */
export async function handleSignIn(
  db: Db,
  claims: EntraClaims,
  mapping: RoleMappingConfig,
  context: { requestId?: string | null } = {},
): Promise<SignInResult> {
  try {
    return await run(db, claims, mapping, context);
  } catch (err) {
    if (isUniqueViolation(err)) return await run(db, claims, mapping, context); // concurrent first sign-in
    throw err;
  }
}

function run(db: Db, claims: EntraClaims, mapping: RoleMappingConfig, context: { requestId?: string | null }): Promise<SignInResult> {
  return db.$transaction(async (tx) => {
    const deny = async (reason: DenialReason, employeeId: string | null): Promise<SignInResult> => {
      await writeAudit(tx, {
        action: "auth.signin_denied",
        actorType: "user",
        actorEmployeeId: employeeId,
        entityType: "employee",
        entityId: employeeId ?? claims.oid,
        requestId: context.requestId,
        changes: { reason },
      });
      return { allowed: false, reason };
    };

    // 1. Employee by oid. Only identity-ish attributes are refreshed here; richer attributes come from the directory sync.
    const employee = await tx.employee.upsert({
      where: { entraObjectId: claims.oid },
      create: {
        entraObjectId: claims.oid,
        userPrincipalName: claims.upn,
        mail: claims.email,
        displayName: claims.displayName,
        lastSyncedAt: new Date(),
      },
      update: { userPrincipalName: claims.upn, mail: claims.email, displayName: claims.displayName },
    });

    if (employee.directoryDeletedAt) return deny("directory_removed", employee.id);
    if (!employee.accountEnabled) return deny("directory_disabled", employee.id);
    if (!employee.isEligible) return deny("not_eligible", employee.id);

    // 2. Application account. An admin-disabled account is denied regardless of Entra.
    const account = await tx.userAccount.upsert({
      where: { employeeId: employee.id },
      create: { employeeId: employee.id },
      update: {},
    });
    if (account.status === "disabled") return deny("account_disabled", employee.id);

    // 3. Replace Entra-sourced roles with the token's roles; manual grants are preserved. Effective role = highest.
    const entraRoles = mapEntraRoles(claims.roles, mapping);
    await tx.userAccountRole.deleteMany({ where: { userAccountId: account.id, source: "entra" } });
    if (entraRoles.length > 0) {
      await tx.userAccountRole.createMany({
        data: entraRoles.map((role) => ({ userAccountId: account.id, role, source: "entra" as const })),
        skipDuplicates: true,
      });
    }
    const all = await tx.userAccountRole.findMany({ where: { userAccountId: account.id }, select: { role: true } });
    const role = highestRole(all.map((r) => r.role));

    const updated = await tx.userAccount.update({
      where: { id: account.id },
      data: { role, lastSignInAt: new Date() },
    });

    await writeAudit(tx, {
      action: "auth.signin",
      actorType: "user",
      actorEmployeeId: employee.id,
      entityType: "user_account",
      entityId: account.id,
      requestId: context.requestId,
      changes: account.role !== role ? { role: [account.role, role] } : null,
    });

    return { allowed: true, userAccountId: updated.id, employeeId: employee.id, sessionVersion: updated.sessionVersion, role } satisfies SignInResult;
  });
}


/** Audit a sign-in rejected before any Employee exists (wrong tenant, malformed oid). Never stores tokens or claims. */
export async function recordSignInDenied(
  db: { auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> } },
  reason: DenialReason,
  context: { requestId?: string | null } = {},
): Promise<void> {
  await writeAudit(db, {
    action: "auth.signin_denied",
    actorType: "user",
    entityType: "external_identity",
    requestId: context.requestId,
    changes: { reason },
  });
}
