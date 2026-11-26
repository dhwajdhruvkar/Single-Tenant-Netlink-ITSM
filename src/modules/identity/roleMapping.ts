// Entra app roles -> application roles. The Entra role *values* are configurable (ENTRA_ROLE_*); unknown values are ignored.
// The implicit baseline for every signed-in, eligible member is `employee`.

export type AppRole = "employee" | "submitter" | "agent" | "manager" | "admin";

export const ROLE_RANK: Record<AppRole, number> = { employee: 0, submitter: 1, agent: 2, manager: 3, admin: 4 };

export interface RoleMappingConfig {
  agent: string;
  manager: string;
  admin: string;
  submitter: string;
}

export const DEFAULT_ROLE_MAPPING: RoleMappingConfig = {
  agent: "ITSM.Agent",
  manager: "ITSM.Manager",
  admin: "ITSM.Admin",
  submitter: "ITSM.Submitter",
};

/** Distinct application roles granted by the token's `roles` claim (never includes the implicit employee role). */
export function mapEntraRoles(claimRoles: unknown, mapping: RoleMappingConfig = DEFAULT_ROLE_MAPPING): AppRole[] {
  if (!Array.isArray(claimRoles)) return [];
  const byValue = new Map<string, AppRole>([
    [mapping.admin, "admin"],
    [mapping.manager, "manager"],
    [mapping.agent, "agent"],
    [mapping.submitter, "submitter"],
  ]);
  const out = new Set<AppRole>();
  for (const value of claimRoles) {
    if (typeof value !== "string") continue;
    const role = byValue.get(value);
    if (role) out.add(role);
  }
  return [...out];
}

/** Highest role wins; `employee` when there are none. */
export function highestRole(roles: Iterable<AppRole>): AppRole {
  let best: AppRole = "employee";
  for (const r of roles) if (ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  return best;
}

export function atLeast(role: AppRole, minimum: AppRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
