import type { PrismaClient } from "@prisma/client";
import type { EligibilityConfig } from "./eligibility";
import type { DirectoryProvider } from "./ports";
import { applyUpsert, type SyncStats } from "./syncService";
import { getEmployeeById, type EmployeeSearchResult } from "./searchService";

export const PROFILE_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

type Db = Pick<PrismaClient, "$queryRaw" | "$transaction" | "employee">;

/**
 * The actor's own directory profile. Refreshes from the directory when the data is older than 24h; a refresh failure is non-fatal.
 * Missing fields stay null (the UI says "Not provided in directory").
 */
export async function getOwnProfile(
  deps: { db: Db; provider: DirectoryProvider | null; eligibility: EligibilityConfig; now?: () => Date },
  employeeId: string,
): Promise<EmployeeSearchResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  const employee = await deps.db.employee.findUnique({ where: { id: employeeId }, select: { entraObjectId: true, lastSyncedAt: true } });
  if (!employee) return null;

  const stale = !employee.lastSyncedAt || now.getTime() - employee.lastSyncedAt.getTime() > PROFILE_REFRESH_AFTER_MS;
  if (stale && deps.provider) {
    try {
      const user = await deps.provider.getUser(employee.entraObjectId);
      if (user) {
        const stats: SyncStats = { created: 0, updated: 0, unchanged: 0, disabled: 0, removed: 0, skipped: 0 };
        await applyUpsert(deps.db, user, deps.eligibility, stats);
      }
    } catch {
      // non-fatal: serve the stored profile
    }
  }
  return getEmployeeById(deps.db, employeeId);
}
