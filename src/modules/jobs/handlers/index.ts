import type { PrismaClient } from "@prisma/client";
import { cleanupAttachments } from "@/modules/attachments/service";
import type { ObjectStorage } from "@/modules/attachments/ports";
import type { EligibilityConfig } from "@/modules/directory/eligibility";
import type { DirectoryProvider } from "@/modules/directory/ports";
import { runDeltaSync, runFullSync } from "@/modules/directory/syncService";
import { evaluateSla } from "@/modules/sla/evaluate";
import { autoCloseResolved } from "@/modules/tickets/autoClose";
import { systemClock, type Clock } from "@/platform/clock";
import { logger } from "@/platform/logging/logger";
import { buildNotificationHandlers } from "@/modules/notifications/dispatcher";
import type { MailSender } from "@/modules/notifications/ports";
import type { HandlerRegistry } from "../runner";

export interface HandlerDeps {
  db: PrismaClient;
  clock?: Clock;
  storage: () => ObjectStorage;
  /** null when Graph is not configured */
  directory: () => { provider: DirectoryProvider; eligibility: EligibilityConfig } | null;
  /** resolved lazily so a bad EMAIL_PROVIDER only fails email jobs, not the whole runner */
  mail: () => MailSender;
  appBaseUrl: string;
}

/**
 * The jobs this build can run. A kind without a handler is left queued by the runner (never failed), so nothing is lost.
 */
export function buildHandlers(deps: HandlerDeps): HandlerRegistry {
  const clock = deps.clock ?? systemClock;
  return {
    ...buildNotificationHandlers({ db: deps.db, mail: deps.mail, appBaseUrl: deps.appBaseUrl }),
    "sla.evaluate": async () => {
      const r = await evaluateSla(deps.db, clock.now());
      if (r.responseBreached || r.resolveBreached || r.warnings) logger.info("sla evaluated", { ...r });
    },
    "ticket.autoclose": async () => {
      const r = await autoCloseResolved(deps.db, clock.now());
      if (r.closed) logger.info("tickets auto-closed", { ...r });
    },
    "attachments.cleanup": async () => {
      const r = await cleanupAttachments({ db: deps.db, storage: deps.storage(), clock });
      logger.info("attachments cleaned up", { ...r });
    },
    "directory.delta": async () => {
      const d = deps.directory();
      if (!d) return void logger.warn("directory.delta skipped: Graph is not configured");
      logger.info("directory delta sync", { ...(await runDeltaSync(deps.db, d.provider, d.eligibility)) });
    },
    "directory.full": async () => {
      const d = deps.directory();
      if (!d) return void logger.warn("directory.full skipped: Graph is not configured");
      logger.info("directory full sync", { ...(await runFullSync(deps.db, d.provider, d.eligibility)) });
    },
  };
}
