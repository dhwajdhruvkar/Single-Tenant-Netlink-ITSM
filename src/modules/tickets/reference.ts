// Ticket numbers come from the Postgres sequence behind Ticket.number (gap-tolerant, never collides). The human
// reference is derived from the type and number and then stored, so it stays fixed if the type is edited later.
// Format INC0001042 / REQ0001043 is [OPEN] pending company confirmation.

export type TicketTypeName = "incident" | "service_request";

const PREFIX: Record<TicketTypeName, string> = { incident: "INC", service_request: "REQ" };

export function formatReference(type: TicketTypeName, number: bigint | number): string {
  const n = typeof number === "bigint" ? number : BigInt(number);
  if (n < 1n) throw new RangeError("ticket number must be positive");
  return `${PREFIX[type]}${n.toString().padStart(7, "0")}`;
}

interface RawClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/** Reserve the next ticket number from the sequence. Call inside the creating transaction. */
export async function allocateTicketNumber(tx: RawClient): Promise<bigint> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval(pg_get_serial_sequence('"Ticket"', 'number')) AS n`;
  const n = rows[0]?.n;
  if (n === undefined) throw new Error("could not allocate a ticket number");
  return BigInt(n);
}
