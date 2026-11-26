import type { Prisma } from "@prisma/client";

// Transactional outbox: job rows are written in the SAME transaction as the change that causes them, so a rolled-back change
// never sends a notification and a committed change never loses one. The runner that drains the table arrives in Phase 8.

export interface JobInput {
  kind: string; // notify.ticket_created | notify.ticket_assigned | sla.evaluate | ...
  payload: Prisma.InputJsonValue;
  /** Unique key: enqueueing the same dedupeKey twice is a no-op. */
  dedupeKey?: string;
  runAfter?: Date;
}

type JobClient = { job: { createMany(args: { data: Prisma.JobCreateManyInput[]; skipDuplicates?: boolean }): Promise<unknown> } };

export async function enqueueJobs(tx: JobClient, jobs: JobInput[]): Promise<void> {
  if (jobs.length === 0) return;
  await tx.job.createMany({
    data: jobs.map((j) => ({ kind: j.kind, payload: j.payload, dedupeKey: j.dedupeKey ?? null, runAfter: j.runAfter ?? new Date() })),
    skipDuplicates: true,
  });
}
