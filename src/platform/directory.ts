import { GraphClient } from "@/modules/directory/graph/graphClient";
import { GraphDirectoryProvider } from "@/modules/directory/graph/graphDirectoryProvider";
import { getGraphToken } from "@/modules/directory/graph/token";
import type { DirectoryProvider } from "@/modules/directory/ports";
import { parseUpnPrefixes, type EligibilityConfig } from "@/modules/directory/eligibility";
import { loadConfig } from "@/platform/config/env";

// Composition root for the directory port. Only the Graph adapter is ever wired here; the fake is for tests.

export function getDirectoryProvider(): DirectoryProvider | null {
  const cfg = loadConfig();
  if (!cfg.GRAPH_TENANT_ID || !cfg.GRAPH_CLIENT_ID || !cfg.GRAPH_CLIENT_SECRET) return null;
  const creds = { tenantId: cfg.GRAPH_TENANT_ID, clientId: cfg.GRAPH_CLIENT_ID, clientSecret: cfg.GRAPH_CLIENT_SECRET };
  return new GraphDirectoryProvider(new GraphClient({ getToken: () => getGraphToken(creds) }));
}

export function getEligibilityConfig(): EligibilityConfig {
  const cfg = loadConfig();
  return { companyName: cfg.DIRECTORY_ELIGIBILITY_COMPANY_NAME, excludeUpnPrefixes: parseUpnPrefixes(cfg.DIRECTORY_ELIGIBILITY_EXCLUDE_UPN_PREFIXES) };
}
