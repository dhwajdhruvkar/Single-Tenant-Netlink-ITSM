import { ForbiddenError } from "@/platform/errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence in depth for cookie-authenticated mutations (SameSite cookies are the first line).
 * Browsers send Sec-Fetch-Site and Origin; a cross-site value is rejected. Requests with neither header come from
 * non-browser clients, which carry no ambient session cookie, and are allowed.
 */
export function assertSameOrigin(req: Request, appBaseUrl: string): void {
  if (!MUTATING.has(req.method.toUpperCase())) return;

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ForbiddenError("Cross-site request rejected.");

  const origin = req.headers.get("origin");
  if (origin) {
    let expected: string;
    try {
      expected = new URL(appBaseUrl).origin;
    } catch {
      throw new ForbiddenError("Cross-site request rejected.");
    }
    if (origin !== expected) throw new ForbiddenError("Cross-site request rejected.");
  }
}
