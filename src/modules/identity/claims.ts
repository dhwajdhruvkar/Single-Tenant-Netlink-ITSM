// Validation of the Entra ID-token claims the app relies on. Identity is the `oid` claim (never email, never the pairwise
// `sub`/providerAccountId); the `tid` claim must equal the configured tenant.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DenialReason =
  | "tenant_mismatch"
  | "invalid_oid"
  | "not_eligible"
  | "directory_disabled"
  | "directory_removed"
  | "account_disabled"
  | "sign_in_failed";

export interface EntraClaims {
  oid: string;
  tid: string;
  upn: string;
  displayName: string;
  email: string | null;
  roles: string[];
}

export type ClaimsResult = { ok: true; claims: EntraClaims } | { ok: false; reason: DenialReason };

export function isGuid(value: unknown): value is string {
  return typeof value === "string" && GUID.test(value);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Pull the claims we need out of an ID-token profile and verify tenant and oid. */
export function readEntraClaims(profile: Record<string, unknown> | undefined, expectedTenantId: string): ClaimsResult {
  if (!profile) return { ok: false, reason: "invalid_oid" };
  const tid = str(profile.tid);
  if (!tid || tid.toLowerCase() !== expectedTenantId.toLowerCase()) return { ok: false, reason: "tenant_mismatch" };
  const oid = str(profile.oid);
  if (!isGuid(oid)) return { ok: false, reason: "invalid_oid" };

  const email = str(profile.email);
  const upn = str(profile.preferred_username) ?? str(profile.upn) ?? email;
  if (!upn) return { ok: false, reason: "invalid_oid" };

  return {
    ok: true,
    claims: {
      oid: oid.toLowerCase(),
      tid: tid.toLowerCase(),
      upn,
      displayName: str(profile.name) ?? upn,
      email,
      roles: Array.isArray(profile.roles) ? profile.roles.filter((r): r is string => typeof r === "string") : [],
    },
  };
}
