import type { DirectoryUser } from "./ports";

// [OPEN] Which directory objects count as employees. Default: enabled Member accounts with a mail or UPN whose UPN does not start
// with a service prefix. Optionally require an exact `companyName`. Group-based eligibility would need GroupMember.Read.All.

export interface EligibilityConfig {
  companyName?: string;
  excludeUpnPrefixes: readonly string[];
}

export function parseUpnPrefixes(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isEligible(user: DirectoryUser, config: EligibilityConfig): boolean {
  if (user.userType !== "Member") return false;
  if (!user.mail && !user.userPrincipalName) return false;
  const upn = user.userPrincipalName.toLowerCase();
  if (config.excludeUpnPrefixes.some((prefix) => upn.startsWith(prefix))) return false;
  if (config.companyName && user.companyName?.trim().toLowerCase() !== config.companyName.trim().toLowerCase()) return false;
  return true;
}
