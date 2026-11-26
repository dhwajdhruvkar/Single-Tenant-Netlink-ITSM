// Names of every migration in prisma/migrations. A unit test fails if this list and the directory disagree, so it
// cannot silently go stale. Used by the startup guard to recognise a database that belongs to a different application.
export const KNOWN_MIGRATIONS: readonly string[] = ["0001_baseline", "0002_indexes_checks", "0003_notification_dedupe"];
