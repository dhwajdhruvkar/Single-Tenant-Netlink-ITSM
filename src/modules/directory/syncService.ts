import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import { isGuid } from "@/modules/identity/claims";
import { isEligible, type EligibilityConfig } from "./eligibility";
import { mapDirectoryUser, type EmployeeFields } from "./mapping";
import type { DirectoryChange, DirectoryProvider, DirectoryUser } from "./ports";

export interface SyncStats {
  created: number;
  updated: number;
  unchanged: number;
  disabled: number;
  removed: number;
  skipped: number;
}

export const DELTA_SCHEDULE = "directory.delta";
const DISABLED_BY_DIRECTORY = "directory";

const emptyStats = (): SyncStats => ({ created: 0, updated: 0, unchanged: 0, disabled: 0, removed: 0, skipped: 0 });

type TxDb = Pick<PrismaClient, "$transaction">;
type Db = TxDb & Pick<PrismaClient, "jobSchedule">;

async function resolveDepartment(tx: Prisma.TransactionClient, raw: string | null): Promise<string | null> {
  if (!raw) return null;
  const found = await tx.department.findFirst({ where: { OR: [{ directoryName: raw }, { name: raw }] }, select: { id: true } });
  if (found) return found.id;
  // Departments are synced from the Entra `department` attribute; admins can add aliases later.
  return (await tx.department.upsert({ where: { name: raw }, create: { name: raw, directoryName: raw }, update: {}, select: { id: true } })).id;
}

async function resolveLocation(tx: Prisma.TransactionClient, raw: string | null): Promise<string | null> {
  if (!raw) return null;
  const found = await tx.location.findFirst({ where: { OR: [{ directoryName: raw }, { name: raw }] }, select: { id: true } });
  if (found) return found.id;
  return (await tx.location.upsert({ where: { name: raw }, create: { name: raw, directoryName: raw }, update: {}, select: { id: true } })).id;
}

const COMPARED: (keyof EmployeeFields)[] = [
  "userPrincipalName", "mail", "displayName", "givenName", "surname", "employeeNumber", "jobTitle",
  "departmentRaw", "officeLocationRaw", "businessPhone", "mobilePhone", "accountEnabled",
];

/** Disable the application account because the directory says the person is gone/disabled/ineligible. */
async function disableAccountForDirectory(tx: Prisma.TransactionClient, employeeId: string, reason: string): Promise<boolean> {
  const account = await tx.userAccount.findUnique({ where: { employeeId } });
  if (!account || account.status === "disabled") return false;
  await tx.userAccount.update({
    where: { id: account.id },
    data: { status: "disabled", disabledAt: new Date(), disabledReason: DISABLED_BY_DIRECTORY, sessionVersion: { increment: 1 } },
  });
  await writeAudit(tx, {
    action: "account.disable", actorType: "job", entityType: "user_account", entityId: account.id,
    actorEmployeeId: null, changes: { reason, source: "directory" },
  });
  return true;
}

/** Re-enable only accounts that the directory sync itself disabled (never an admin's manual disable). */
async function reenableDirectoryDisabled(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
  const account = await tx.userAccount.findUnique({ where: { employeeId } });
  if (account?.status === "disabled" && account.disabledReason === DISABLED_BY_DIRECTORY) {
    await tx.userAccount.update({ where: { id: account.id }, data: { status: "active", disabledAt: null, disabledReason: null } });
    await writeAudit(tx, {
      action: "account.enable", actorType: "job", entityType: "user_account", entityId: account.id, changes: { source: "directory" },
    });
  }
}

/** Upsert one directory user. Only writes when something actually changed. */
export async function applyUpsert(db: TxDb, user: DirectoryUser, eligibility: EligibilityConfig, stats: SyncStats): Promise<string | null> {
  if (!isGuid(user.oid)) {
    stats.skipped += 1;
    return null;
  }
  const oid = user.oid.toLowerCase();
  const fields = mapDirectoryUser(user);
  const eligible = isEligible(user, eligibility);

  return db.$transaction(async (tx) => {
    const existing = await tx.employee.findUnique({ where: { entraObjectId: oid } });
    const departmentId = await resolveDepartment(tx, fields.departmentRaw);
    const locationId = await resolveLocation(tx, fields.officeLocationRaw);
    const now = new Date();

    let employeeId: string;
    if (!existing) {
      const created = await tx.employee.create({
        data: { entraObjectId: oid, ...fields, departmentId, locationId, isEligible: eligible, lastSyncedAt: now },
      });
      employeeId = created.id;
      stats.created += 1;
    } else {
      employeeId = existing.id;
      const changed =
        COMPARED.some((k) => existing[k] !== fields[k]) ||
        existing.departmentId !== departmentId ||
        existing.locationId !== locationId ||
        existing.isEligible !== eligible ||
        existing.directoryDeletedAt !== null;
      if (changed) {
        await tx.employee.update({
          where: { id: existing.id },
          data: { ...fields, departmentId, locationId, isEligible: eligible, directoryDeletedAt: null, lastSyncedAt: now },
        });
        stats.updated += 1;
      } else {
        await tx.employee.update({ where: { id: existing.id }, data: { lastSyncedAt: now } });
        stats.unchanged += 1;
      }
    }

    if (!eligible || !fields.accountEnabled) {
      if (await disableAccountForDirectory(tx, employeeId, !fields.accountEnabled ? "directory_disabled" : "not_eligible")) stats.disabled += 1;
    } else {
      await reenableDirectoryDisabled(tx, employeeId);
    }
    return employeeId;
  });
}

/** The directory no longer has this object. Employees are never hard-deleted. */
export async function applyRemoval(db: TxDb, oid: string, stats: SyncStats): Promise<void> {
  if (!isGuid(oid)) return;
  await db.$transaction(async (tx) => {
    const employee = await tx.employee.findUnique({ where: { entraObjectId: oid.toLowerCase() } });
    if (!employee) return;
    if (!employee.directoryDeletedAt) {
      await tx.employee.update({ where: { id: employee.id }, data: { directoryDeletedAt: new Date(), accountEnabled: false } });
      stats.removed += 1;
    }
    if (await disableAccountForDirectory(tx, employee.id, "directory_removed")) stats.disabled += 1;
  });
}

async function applyChanges(db: Db, changes: DirectoryChange[], eligibility: EligibilityConfig, stats: SyncStats): Promise<string[]> {
  const touched: string[] = [];
  for (const change of changes) {
    if (change.kind === "removed") await applyRemoval(db, change.oid, stats);
    else {
      const id = await applyUpsert(db, change.user, eligibility, stats);
      if (id) touched.push(change.user.oid.toLowerCase());
    }
  }
  return touched;
}

async function syncManagers(db: Db, provider: DirectoryProvider, oids: string[]): Promise<void> {
  const CONCURRENCY = 5;
  for (let i = 0; i < oids.length; i += CONCURRENCY) {
    await Promise.all(
      oids.slice(i, i + CONCURRENCY).map(async (oid) => {
        let managerOid: string | null = null;
        try {
          managerOid = await provider.getManagerOid(oid);
        } catch {
          return; // a manager lookup failure must not fail the sync; the next full sync retries
        }
        const manager = managerOid && isGuid(managerOid) ? await db.$transaction((tx) => tx.employee.findUnique({ where: { entraObjectId: managerOid!.toLowerCase() }, select: { id: true } })) : null;
        await db.$transaction((tx) => tx.employee.updateMany({ where: { entraObjectId: oid }, data: { managerId: manager?.id ?? null } }));
      }),
    );
  }
}

async function saveCursor(db: Db, cursor: string, now: Date): Promise<void> {
  await db.jobSchedule.upsert({
    where: { name: DELTA_SCHEDULE },
    create: { name: DELTA_SCHEDULE, cursor, lastSuccessAt: now, lastError: null },
    update: { cursor, lastSuccessAt: now, lastError: null },
  });
}

/** Full sync: enumerate everyone (initial delta), then resolve managers, then store the new delta cursor. */
export async function runFullSync(db: Db, provider: DirectoryProvider, eligibility: EligibilityConfig): Promise<SyncStats> {
  const stats = emptyStats();
  const result = await provider.delta(null);
  const touched = await applyChanges(db, result.changes, eligibility, stats);
  await syncManagers(db, provider, touched);
  await saveCursor(db, result.cursor, new Date());
  return stats;
}

/** Incremental sync from the stored cursor; falls back to a full sync when there is none. */
export async function runDeltaSync(db: Db, provider: DirectoryProvider, eligibility: EligibilityConfig): Promise<SyncStats> {
  const schedule = await db.jobSchedule.findUnique({ where: { name: DELTA_SCHEDULE } });
  if (!schedule?.cursor) return runFullSync(db, provider, eligibility);
  const stats = emptyStats();
  try {
    const result = await provider.delta(schedule.cursor);
    await applyChanges(db, result.changes, eligibility, stats);
    await saveCursor(db, result.cursor, new Date());
  } catch (err) {
    await db.jobSchedule.update({ where: { name: DELTA_SCHEDULE }, data: { lastError: err instanceof Error ? err.message.slice(0, 500) : "delta sync failed" } });
    throw err;
  }
  return stats;
}
