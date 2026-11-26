import type { Prisma, PrismaClient, Ticket } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import type { Actor } from "@/modules/identity/actor";
import type { PolicyOptions } from "@/modules/identity/permissions";
import { systemClock, type Clock } from "@/platform/clock";
import { NotFoundError, StaleVersionError } from "@/platform/errors";
import { visibleTicketsWhere } from "./access";
import { DEFAULT_PAUSING_REASONS } from "@/modules/sla/pause";

// Shared plumbing for the ticket mutation services (status, fields, assignment, messages, archive).

export interface OpsDeps {
  db: PrismaClient;
  clock?: Clock;
  /** Injectable for tests (e.g. to prove a failed audit write rolls the whole change back). */
  audit?: typeof writeAudit;
  policy?: PolicyOptions;
}

export interface OpsContext {
  requestId?: string;
}

export const nowOf = (deps: OpsDeps): Date => (deps.clock ?? systemClock).now();
export const auditOf = (deps: OpsDeps) => deps.audit ?? writeAudit;

/** The ticket, only if the actor may see it; otherwise 404 (existence is never revealed). Archived tickets are not reachable. */
export async function loadVisibleTicket(tx: Prisma.TransactionClient, actor: Actor, reference: string, policy?: PolicyOptions): Promise<Ticket> {
  const t = await tx.ticket.findFirst({ where: { AND: [visibleTicketsWhere(actor, policy), { reference }] } });
  if (!t) throw new NotFoundError();
  return t;
}

/**
 * Optimistic concurrency: the write succeeds only if the row still has the version the client saw. The early compare gives a quick
 * answer; the conditional UPDATE is what actually prevents two writers both succeeding.
 */
export async function applyVersioned(tx: Prisma.TransactionClient, ticket: Ticket, version: number, data: Prisma.TicketUncheckedUpdateManyInput): Promise<Ticket> {
  if (ticket.version !== version) throw new StaleVersionError();
  const r = await tx.ticket.updateMany({ where: { id: ticket.id, version }, data: { ...data, version: { increment: 1 } } });
  if (r.count !== 1) throw new StaleVersionError();
  return tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
}

export interface EventInput {
  ticketId: string;
  type: string;
  actorEmployeeId: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  data?: Prisma.InputJsonValue;
}

export async function recordEvent(tx: Prisma.TransactionClient, e: EventInput): Promise<void> {
  await tx.ticketEvent.create({
    data: { ticketId: e.ticketId, type: e.type, actorEmployeeId: e.actorEmployeeId, fromValue: e.fromValue ?? null, toValue: e.toValue ?? null, data: e.data },
  });
}

export interface TicketSettings {
  reopenWindowDays: number;
  pausingHoldReasons: readonly string[];
}

/** Company settings that drive the lifecycle ([OPEN] defaults: 7-day reopen window, only `awaiting_requester` pauses the SLA). */
export async function loadTicketSettings(db: Pick<Prisma.TransactionClient, "companySetting">): Promise<TicketSettings> {
  const rows = await db.companySetting.findMany({ where: { key: { in: ["ticket.reopenWindowDays", "sla.pauseHoldReasons"] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const days = get("ticket.reopenWindowDays");
  const reasons = get("sla.pauseHoldReasons");
  return {
    reopenWindowDays: typeof days === "number" && days >= 0 ? days : 7,
    pausingHoldReasons: Array.isArray(reasons) && reasons.every((r) => typeof r === "string") ? (reasons as string[]) : DEFAULT_PAUSING_REASONS,
  };
}

export interface TicketResultDTO {
  id: string;
  reference: string;
  status: string;
  version: number;
}

export const resultOf = (t: Ticket): TicketResultDTO => ({ id: t.id, reference: t.reference, status: t.status, version: t.version });
