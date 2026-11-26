import { after } from "next/server";
import { loadConfig } from "@/platform/config/env";
import { runDueJobs } from "@/modules/jobs/runner";
import { prisma } from "@/platform/db/prisma";
import { logger } from "@/platform/logging/logger";
import { jobHandlers, runnerId } from "@/platform/jobs";

/**
 * Right after a response, drain a few due jobs so notifications go out promptly (JOBS_INLINE_DISPATCH, default on). This is an optimisation
 * only: the cron endpoint or the worker is the guaranteed path, and a failure here never affects the request that triggered it.
 */
export function dispatchJobsAfterResponse(): void {
  if (!loadConfig().JOBS_INLINE_DISPATCH) return;
  after(async () => {
    try {
      await runDueJobs({ db: prisma, handlers: jobHandlers(), owner: runnerId("inline"), maxJobs: 10, budgetMs: 8_000 });
    } catch (err) {
      logger.error("inline job dispatch failed", { error: err });
    }
  });
}
