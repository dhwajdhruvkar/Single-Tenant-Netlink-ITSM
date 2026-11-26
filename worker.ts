// Standalone job worker: `npm run worker`. Runs the same schedules and jobs as the cron endpoint, in a loop, so a long-lived host (company
// server) needs no external scheduler. Needs the same environment as the app (DATABASE_URL etc.); APP_ROLE is informational.
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { logger } from "@/platform/logging/logger";
import { runJobsOnce, runnerId } from "@/platform/jobs";
import { runWorker } from "@/platform/workerLoop";

async function main() {
  const cfg = loadConfig();
  const owner = runnerId("worker");
  const abort = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logger.info("worker stopping", { signal: sig });
      abort.abort();
    });
  }
  logger.info("worker started", { owner, pollMs: cfg.WORKER_POLL_MS });
  await runWorker({
    intervalMs: cfg.WORKER_POLL_MS,
    signal: abort.signal,
    tick: async () => {
      const r = await runJobsOnce({ owner, maxJobs: 50, budgetMs: 50_000 });
      if (r.claimed || r.schedulesFired.length) logger.info("worker pass", { ...r });
    },
  });
  await prisma.$disconnect();
  logger.info("worker stopped");
}

main().catch((err) => {
  logger.error("worker crashed", { error: err });
  process.exit(1);
});
