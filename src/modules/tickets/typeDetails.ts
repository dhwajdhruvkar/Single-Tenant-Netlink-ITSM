// Type-specific ticket details (stored in Ticket.typeDetails). Adapted from the reference sanitiser: only fields valid for the
// type survive; unknown keys, wrong types and over-long values are dropped. Launch types: incident and service_request.

export const TYPE_DETAIL_LIMITS = { short: 200, long: 4000 } as const;

export type TicketTypeName = "incident" | "service_request";

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t && t.length <= max ? t : undefined;
}

/** Returns the permitted fields for `type`, or null when nothing usable remains. */
export function sanitizeTypeDetails(type: TicketTypeName, raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  if (type === "incident") {
    put("affectedService", text(input.affectedService, TYPE_DETAIL_LIMITS.short));
  } else {
    put("requestedItem", text(input.requestedItem, TYPE_DETAIL_LIMITS.short));
    put("fulfilmentDetails", text(input.fulfilmentDetails, TYPE_DETAIL_LIMITS.long));
  }
  return Object.keys(out).length ? out : null;
}
