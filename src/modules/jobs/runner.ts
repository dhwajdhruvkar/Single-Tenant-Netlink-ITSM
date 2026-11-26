import { Prisma, type PrismaClient } from "@prisma/client";
import { systemClock, type Clock } from "@/platform/clock";
import { logger } from "@/platform/logging/logger";

// Database-backed job runner. Stateless: any number of web instances and workers can run it at once. Jobs are claimed with
// FOR UPDATE SKIP LOCKED, so each job is handed to exactly one runner; a runner that crashes mid-job loses its lease and the job is
// picked up again. Correctness never depends on this process staying alive (SLA status is derived on read).

export interface ClaimedJob {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;
export type HandlerRegistry = Record<string, JobHandler>;

export interface RunOptions {
  db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
  handlers: HandlerRegistry;
  /** Identifies this runner in `lockedBy`. */
  owner: string;
  clock?: Clock;
  maxJobs?: number;
  /** Stop starting new jobs after this many ms (e.g. 50 s inside a 60 s serverless function). */
  budgetMs?: number;
  /** How long a claim is valid. A job still running after this is considered abandoned and may be claimed again. */
  leaseSeconds?: number;
  batchSize?: number;
}

export interface RunResult {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;

/** 1 min * 2^(attempt-1), capped at 1 hour. `attempt` is the number of attempts made so far (>= 1). */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
}

async function claim(db: RunOptions["db"], kinds: string[], owner: string, now: Date, leaseSeconds: number, limit: number): Promise<ClaimedJob[]> {
  if (kinds.length === 0 || limit <= 0) return [];
  const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000);
  return db.$queryRaw<ClaimedJob[]>(Prisma.sql`
    UPDATE "Job" SET "status" = 'running', "attempts" = "attempts" + 1, "lockedBy" = ${owner}, "lockedUntil" = ${lockedUntil}
    WHERE "id" IN (
      SELECT "id" FROM "Job"
      WHERE "kind" IN (${Prisma.join(kinds)})
        AND (("status" = 'queued' AND "runAfter" <= ${now}) OR ("status" = 'running' AND "lockedUntil" < ${now}))
      ORDER BY "runAfter" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING "id", "kind", "payload", "attempts", "maxAttempts"`);
}

/** Process due jobs. Only kinds that have a registered handler are claimed; anything else stays queued for whoever can handle it. */
export async function runDueJobs(opts: RunOptions): Promise<RunResult> {
  const clock = opts.clock ?? systemClock;
  const maxJobs = opts.maxJobs ?? 20;
  const lease = opts.leaseSeconds ?? 300;
  const deadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : Number.POSITIVE_INFINITY;
  const kinds = Object.keys(opts.handlers);
  const result: RunResult = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };

  while (result.claimed < maxJobs && Date.now() < deadline) {
    const batch = await claim(opts.db, kinds, opts.owner, clock.now(), lease, Math.min(opts.batchSize ?? 5, maxJobs - result.claimed));
    if (batch.length === 0) break;
    result.claimed += batch.length;

    for (const job of batch) {
      if (job.attempts > job.maxAttempts) {
        // an abandoned job that has already used all its attempts
        await finish(opts, job, "dead", clock.now(), "abandoned after the last attempt");
        result.dead += 1;
        continue;
      }
      try {
        await opts.handlers[job.kind](job);
        await finish(opts, job, "succeeded", clock.now());
        result.succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000);
        logger.error("job failed", { jobId: job.id, kind: job.kind, attempt: job.attempts, error: err });
        if (job.attempts >= job.maxAttempts) {
          await finish(opts, job, "dead", clock.now(), message);
          result.dead += 1;
        } else {
          await finish(opts, job, "retry", clock.now(), message);
          result.retried += 1;
        }
      }
    }
  }
  return result;
}

async function finish(opts: RunOptions, job: ClaimedJob, outcome: "succeeded" | "dead" | "retry", now: Date, error?: string): Promise<void> {
  // Only the runner that still holds the claim may finish it.
  if (outcome === "succeeded") {
    await opts.db.$executeRaw`UPDATE "Job" SET "status" = 'succeeded', "completedAt" = ${now}, "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = NULL WHERE "id" = ${job.id}::uuid AND "lockedBy" = ${opts.owner}`;
  } else if (outcome === "dead") {
    await opts.db.$executeRaw`UPDATE "Job" SET "status" = 'dead', "completedAt" = ${now}, "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = ${error ?? null} WHERE "id" = ${job.id}::uuid AND "lockedBy" = ${opts.owner}`;
  } else {
    const runAfter = new Date(now.getTime() + backoffMs(job.attempts));
    await opts.db.$executeRaw`UPDATE "Job" SET "status" = 'queued', "runAfter" = ${runAfter}, "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = ${error ?? null} WHERE "id" = ${job.id}::uuid AND "lockedBy" = ${opts.owner}`;
  }
}
