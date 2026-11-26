import { Prisma, type PrismaClient } from "@prisma/client";
import { isEligible, type EligibilityConfig } from "./eligibility";
import type { DirectoryProvider } from "./ports";
import { applyUpsert, type SyncStats } from "./syncService";

// Local-first employee search. `entraObjectId` is deliberately NOT exposed.

export interface EmployeeSearchResult {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  employeeNumber: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
}

export const MIN_QUERY_LENGTH = 2;
export const GRAPH_FALLBACK_MIN_QUERY_LENGTH = 3;
export const GRAPH_FALLBACK_THRESHOLD = 3;
const MAX_TOKENS = 4;

type Db = Pick<PrismaClient, "$queryRaw" | "$transaction" | "employee">;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function tokenize(q: string): string[] {
  return q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, MAX_TOKENS);
}

// MUST stay identical to the expression in migration 0002 (employee_search_trgm) so the index can be used.
const SEARCH_EXPR = Prisma.sql`lower(e."displayName" || ' ' || coalesce(e."mail", '') || ' ' || e."userPrincipalName" || ' ' || coalesce(e."employeeNumber", ''))`;

export async function searchLocal(db: Pick<PrismaClient, "$queryRaw">, q: string, limit: number): Promise<EmployeeSearchResult[]> {
  const tokens = tokenize(q);
  if (tokens.length === 0) return [];
  const whole = escapeLike(q.trim().toLowerCase());
  const conditions = tokens.map((t) => Prisma.sql`${SEARCH_EXPR} LIKE ${"%" + escapeLike(t) + "%"}`);
  return db.$queryRaw<EmployeeSearchResult[]>(Prisma.sql`
    SELECT e.id, e."displayName", e.mail, e."userPrincipalName", e."employeeNumber", e."jobTitle",
           coalesce(d.name, e."departmentRaw") AS department, coalesce(l.name, e."officeLocationRaw") AS "officeLocation"
    FROM "Employee" e
    LEFT JOIN "Department" d ON d.id = e."departmentId"
    LEFT JOIN "Location" l ON l.id = e."locationId"
    WHERE e."isEligible" AND e."accountEnabled" AND e."directoryDeletedAt" IS NULL
      AND ${Prisma.join(conditions, " AND ")}
    ORDER BY (lower(e."displayName") LIKE ${whole + "%"}) DESC,
             (lower(coalesce(e.mail, '')) LIKE ${whole + "%"}) DESC,
             (lower(e."userPrincipalName") LIKE ${whole + "%"}) DESC,
             e."displayName" ASC
    LIMIT ${limit}`);
}

export interface SearchDeps {
  db: Db;
  /** null when Graph is not configured: search is then local only. */
  provider: DirectoryProvider | null;
  eligibility: EligibilityConfig;
}

/** Local DB first; if it finds fewer than 3 and the query is >= 3 chars, ask Graph, upsert, and re-query. */
export async function searchEmployees(deps: SearchDeps, query: string, limit: number): Promise<EmployeeSearchResult[]> {
  const q = query.trim();
  let results = await searchLocal(deps.db, q, limit);
  if (deps.provider && results.length < GRAPH_FALLBACK_THRESHOLD && q.length >= GRAPH_FALLBACK_MIN_QUERY_LENGTH) {
    try {
      const found = await deps.provider.searchUsers(q, 10);
      const stats: SyncStats = { created: 0, updated: 0, unchanged: 0, disabled: 0, removed: 0, skipped: 0 };
      for (const user of found) {
        if (isEligible(user, deps.eligibility)) await applyUpsert(deps.db, user, deps.eligibility, stats);
      }
      if (found.length > 0) results = await searchLocal(deps.db, q, limit);
    } catch {
      // The directory being unreachable must not break search: return what the local database has.
    }
  }
  return results;
}

export async function getEmployeeById(db: Pick<PrismaClient, "$queryRaw">, id: string): Promise<EmployeeSearchResult | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const rows = await db.$queryRaw<EmployeeSearchResult[]>(Prisma.sql`
    SELECT e.id, e."displayName", e.mail, e."userPrincipalName", e."employeeNumber", e."jobTitle",
           coalesce(d.name, e."departmentRaw") AS department, coalesce(l.name, e."officeLocationRaw") AS "officeLocation"
    FROM "Employee" e
    LEFT JOIN "Department" d ON d.id = e."departmentId"
    LEFT JOIN "Location" l ON l.id = e."locationId"
    WHERE e.id = ${id}::uuid AND e."isEligible" AND e."accountEnabled" AND e."directoryDeletedAt" IS NULL`);
  return rows[0] ?? null;
}
