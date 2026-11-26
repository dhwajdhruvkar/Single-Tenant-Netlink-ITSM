import type { Prisma, PrismaClient } from "@prisma/client";
import { systemClock, type Clock } from "@/platform/clock";

// Recurring jobs. A schedule does not run anything itself: each time slot it enqueues one Job. The slot is claimed with a conditional
// UPDATE of JobSchedule.lastSlotAt inside the same transaction as the INSERT, so however many runners call this, a slot produces one job.

export interface ScheduleDef {
  /** also the Job.kind */
  name: string;
  intervalMs: number;
  /** schedules can be switched off by configuration (e.g. directory sync without Graph credentials) */
  enabled: boolean;
}

const MIN = 60_000;

export function defaultSchedules(cfg: { directorySyncEnabled: boolean }): ScheduleDef[] {
  return [
    { name: "sla.evaluate", intervalMs: MIN, enabled: true },
    { name: "ticket.autoclose", intervalMs: 60 * MIN, enabled: true },
    { name: "attachments.cleanup", intervalMs: 24 * 60 * MIN, enabled: true },
    { name: "directory.delta", intervalMs: 30 * MIN, enabled: cfg.directorySyncEnabled },
    { name: "directory.full", intervalMs: 24 * 60 * MIN, enabled: cfg.directorySyncEnabled },
  ];
}

/** Start of the interval that contains `now` (slots are aligned to the epoch so every runner agrees on them). */
export function slotStart(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

type Db = Pick<PrismaClient, "$transaction">;

/** Enqueue the job for the current slot of every enabled schedule that has not produced one yet. Returns the schedules that fired. */
export async function runDueSchedules(db: Db, schedules: ScheduleDef[], clock: Clock = systemClock): Promise<string[]> {
  const now = clock.now();
  const fired: string[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const slot = slotStart(now, s.intervalMs);
    const won = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // INSERT ... ON CONFLICT DO NOTHING: concurrent first runs must not collide on the unique name (an upsert would race)
      await tx.jobSchedule.createMany({ data: [{ name: s.name }], skipDuplicates: true });
      const claimed = await tx.jobSchedule.updateMany({
        where: { name: s.name, OR: [{ lastSlotAt: null }, { lastSlotAt: { lt: slot } }] },
        data: { lastSlotAt: slot },
      });
      if (claimed.count !== 1) return false;
      await tx.job.createMany({
        data: [{ kind: s.name, payload: { slot: slot.toISOString() }, dedupeKey: `schedule:${s.name}:${slot.toISOString()}`, runAfter: now }],
        skipDuplicates: true,
      });
      return true;
    });
    if (won) fired.push(s.name);
  }
  return fired;
}
