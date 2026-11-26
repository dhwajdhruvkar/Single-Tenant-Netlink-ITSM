import { DatabaseStorage } from "@/modules/attachments/providers/databaseStorage";
import { LocalDiskStorage } from "@/modules/attachments/providers/localDiskStorage";
import { UnavailableStorage } from "@/modules/attachments/providers/unavailableStorage";
import { keyEnvFor } from "@/modules/attachments/keys";
import { noopScanner } from "@/modules/attachments/ports";
import type { ObjectStorage } from "@/modules/attachments/ports";
import { effectiveMaxBytes } from "@/modules/attachments/validation";
import type { AttachmentDeps } from "@/modules/attachments/service";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { AppError } from "@/platform/errors";

// Composition root for attachment storage. Provider choice is configuration only; modules never see which one is in use.

export function getStorage(): ObjectStorage {
  const cfg = loadConfig();
  switch (cfg.STORAGE_PROVIDER) {
    case "database": return new DatabaseStorage(prisma);
    case "local": return new LocalDiskStorage(cfg.STORAGE_LOCAL_DIR);
    case "s3":
    case "azure_blob": return new UnavailableStorage(cfg.STORAGE_PROVIDER);
  }
}

/** Dependencies for the attachment service, or a 503 when the feature is switched off (rollback flag ATTACHMENTS_ENABLED=false). */
export function getAttachmentDeps(): AttachmentDeps {
  const cfg = loadConfig();
  if (!cfg.ATTACHMENTS_ENABLED) throw new AppError(503, "attachments_disabled", "Attachments are currently disabled.");
  return {
    db: prisma,
    storage: getStorage(),
    keyEnv: keyEnvFor(cfg.APP_ENV),
    maxBytes: effectiveMaxBytes(cfg),
    scanner: noopScanner,
    requireCleanScan: cfg.ATTACHMENT_REQUIRE_CLEAN_SCAN,
    policy: { agentsViewAllTickets: cfg.AGENTS_VIEW_ALL_TICKETS },
  };
}

/** UI settings for the attachment controls, or undefined when attachments are switched off (the controls are then not rendered). */
export function attachmentsUiConfig(): { maxBytes: number } | undefined {
  const cfg = loadConfig();
  return cfg.ATTACHMENTS_ENABLED ? { maxBytes: effectiveMaxBytes(cfg) } : undefined;
}
