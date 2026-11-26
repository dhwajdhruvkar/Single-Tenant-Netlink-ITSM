import { createHash, timingSafeEqual } from "node:crypto";
import { UnauthenticatedError } from "@/platform/errors";

export const MIN_CRON_SECRET_LENGTH = 32;

/**
 * Check `Authorization: Bearer <CRON_SECRET>` for the job endpoint. The comparison is constant-time (digests of equal length), and a
 * missing, too-short or unset secret never authenticates anyone: the endpoint is closed unless a strong secret is configured.
 */
export function assertCronAuthorized(req: Request, secret: string | undefined): void {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  const presented = match?.[1] ?? "";
  const configured = secret && secret.length >= MIN_CRON_SECRET_LENGTH ? secret : null;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured ?? "\u0000no-secret-configured").digest();
  const equal = timingSafeEqual(a, b);
  if (!configured || !presented || !equal) throw new UnauthenticatedError("Invalid credentials.");
}
