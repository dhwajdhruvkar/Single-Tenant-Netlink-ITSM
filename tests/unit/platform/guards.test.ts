import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateDatabaseGuard } from "@/platform/db/guards";
import { KNOWN_MIGRATIONS } from "@/platform/db/knownMigrations";

describe("evaluateDatabaseGuard", () => {
  it("accepts an empty database and one migrated by this repository", () => {
    expect(evaluateDatabaseGuard({ hasTenantTable: false, appliedMigrations: [] }, KNOWN_MIGRATIONS)).toEqual([]);
    expect(evaluateDatabaseGuard({ hasTenantTable: false, appliedMigrations: [...KNOWN_MIGRATIONS] }, KNOWN_MIGRATIONS)).toEqual([]);
  });
  it("refuses a Tenant table", () => {
    const r = evaluateDatabaseGuard({ hasTenantTable: true, appliedMigrations: [] }, KNOWN_MIGRATIONS);
    expect(r.join()).toMatch(/Tenant/);
  });
  it("refuses migrations that are not in this repository", () => {
    const r = evaluateDatabaseGuard({ hasTenantTable: false, appliedMigrations: ["20261113090000_performance_indexes"] }, KNOWN_MIGRATIONS);
    expect(r.join()).toMatch(/20261113090000_performance_indexes/);
  });
});

describe("KNOWN_MIGRATIONS", () => {
  it("matches the prisma/migrations directory exactly", () => {
    const dirs = readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect([...KNOWN_MIGRATIONS].sort()).toEqual(dirs);
  });
});
