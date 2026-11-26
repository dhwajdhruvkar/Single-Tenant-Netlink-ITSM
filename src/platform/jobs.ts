import { hostname } from "node:os";
import { getEligibilityConfig, getDirectoryProvider } from "@/platform/directory";
import { buildHandlers } from "@/modules/jobs/handlers";
import { runDueJobs, type RunResult } from "@/modules/jobs/runner";
import { defaultSchedules, runDueSchedules } from "@/modules/jobs/schedules";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getMailSender } from "@/platform/mail";
import { getStorage } from "@/platform/storage";

// Composition root for background work. The same function serves the cron endpoint, the worker process and inline dispatch.

export function jobHandlers() {
  return buildHandlers({
    db: prisma,
    storage: getStorage,
    mail: getMailSender,
    appBaseUrl: loadConfig().APP_BASE_URL,
    directory: () => {
      const provider = getDirectoryProvider();
      return provider ? { provider, eligibility: getEligibilityConfig() } : null;
    },
  });
}

export function jobSchedules() {
  const cfg = loadConfig();
  const configured = Boolean(cfg.GRAPH_TENANT_ID && cfg.GRAPH_CLIENT_ID && cfg.GRAPH_CLIENT_SECRET);
  return defaultSchedules({ directorySyncEnabled: cfg.DIRECTORY_SYNC_ENABLED && configured });
}

export const runnerId = (kind: string) => `${kind}:${hostname()}:${process.pid}`;

export interface RunOnce extends RunResult {
  schedulesFired: string[];
}

/** One pass: enqueue due schedule slots, then process up to `maxJobs` jobs within `budgetMs`. */
export async function runJobsOnce(opts: { owner: string; maxJobs?: number; budgetMs?: number }): Promise<RunOnce> {
  const schedulesFired = await runDueSchedules(prisma, jobSchedules());
  const r = await runDueJobs({ db: prisma, handlers: jobHandlers(), owner: opts.owner, maxJobs: opts.maxJobs ?? 50, budgetMs: opts.budgetMs ?? 50_000 });
  return { ...r, schedulesFired };
}
