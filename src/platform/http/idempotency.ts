import { ValidationError } from "@/platform/errors";
import { IDEMPOTENCY_KEY } from "@/modules/tickets/contracts";

/** The optional Idempotency-Key header: 8-128 chars of [A-Za-z0-9._:-]. */
export function readIdempotencyKey(req: Request): string | undefined {
  const raw = req.headers.get("idempotency-key");
  if (raw === null) return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new ValidationError("Idempotency-Key must be 8-128 characters of letters, digits and . _ : -");
  return raw;
}
