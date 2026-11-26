// Startup guard: refuse to run against a database that belongs to another application (for example the original,
// multi-tenant helpdesk database). Pure decision function + a thin query wrapper so both are testable.

export interface GuardFacts {
  hasTenantTable: boolean;
  appliedMigrations: readonly string[];
}

export class UnsafeDatabaseError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Refusing to use this database: ${reasons.join("; ")}`);
    this.name = "UnsafeDatabaseError";
  }
}

export function evaluateDatabaseGuard(facts: GuardFacts, knownMigrations: readonly string[]): string[] {
  const reasons: string[] = [];
  if (facts.hasTenantTable) {
    reasons.push('a "Tenant" table exists (this looks like the original multi-tenant application database)');
  }
  const known = new Set(knownMigrations);
  const foreign = facts.appliedMigrations.filter((name) => !known.has(name));
  if (foreign.length > 0) {
    reasons.push(`migration history contains migrations that are not in this repository: ${foreign.slice(0, 5).join(", ")}`);
  }
  return reasons;
}

interface QueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** Read-only inspection of the connected database. Throws UnsafeDatabaseError when it is not ours. */
export async function assertSafeDatabase(client: QueryClient, knownMigrations: readonly string[]): Promise<void> {
  const tenant = await client.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'Tenant') AS "exists"`,
  );
  const hasMigrationTable = await client.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '_prisma_migrations') AS "exists"`,
  );
  let applied: string[] = [];
  if (hasMigrationTable[0]?.exists) {
    const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations"`,
    );
    applied = rows.map((r) => r.migration_name);
  }
  const reasons = evaluateDatabaseGuard({ hasTenantTable: Boolean(tenant[0]?.exists), appliedMigrations: applied }, knownMigrations);
  if (reasons.length > 0) throw new UnsafeDatabaseError(reasons);
}
