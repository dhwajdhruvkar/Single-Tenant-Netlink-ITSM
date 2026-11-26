import { loadConfig, ConfigError } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { assertSafeDatabase, UnsafeDatabaseError } from "@/platform/db/guards";
import { KNOWN_MIGRATIONS } from "@/platform/db/knownMigrations";
import { logger } from "@/platform/logging/logger";

// Node.js-only startup checks. A bad configuration, or a database that belongs to another application (for example the
// original multi-tenant helpdesk), stops the process with a readable message and a non-zero exit code.
export async function validateStartup(): Promise<void> {
  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
    throw err;
  }

  try {
    await assertSafeDatabase(prisma, KNOWN_MIGRATIONS);
  } catch (err) {
    if (err instanceof UnsafeDatabaseError) {
      console.error(err.message);
      process.exit(1);
    }
    // Database unreachable at boot: not fatal here. /api/ready reports it and the platform keeps retrying.
    logger.warn("database safety check skipped (database not reachable yet)", { error: err });
  }
}
