import { PrismaClient } from "@prisma/client";

// Integration tests only ever run against a local, disposable test database: host must be localhost/127.0.0.1/postgres
// and the database name must end in _test. They truncate tables between files, so this guard is the safety net that keeps
// them away from any cloud database.

export const DEFAULT_TEST_DATABASE_URL = "postgresql://itsm:itsm@localhost:5432/itsm_test";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  assertLocalTestDatabase(url);
  return url;
}

export function assertLocalTestDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Integration tests: database URL is not a valid URL");
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Integration tests refuse to run against host "${parsed.hostname}" (allowed: ${[...ALLOWED_HOSTS].join(", ")})`);
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(`Integration tests refuse to run against database "${dbName}" (name must end with _test)`);
  }
}

let client: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  client ??= new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
  return client;
}

/** Empty every application table (not Prisma's bookkeeping table). Sequences are left alone. */
export async function resetDatabase(prisma: PrismaClient = testPrisma()): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
