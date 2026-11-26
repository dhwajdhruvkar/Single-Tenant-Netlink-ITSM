import { z } from "zod";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { ForbiddenError } from "@/platform/errors";
import { auditOf, applyVersioned, loadVisibleTicket, nowOf, recordEvent, resultOf, type OpsContext, type OpsDeps, type TicketResultDTO } from "./ops";

export const ArchiveInput = z.object({ version: z.number().int().min(0), reason: z.string().trim().min(3).max(500).optional() }).strict();
export type ArchiveInputT = z.infer<typeof ArchiveInput>;

/** Soft delete (manager+). Archived tickets disappear from every list and from direct access; nothing is ever hard-deleted by the app. */
export async function archiveTicket(deps: OpsDeps, actor: Actor, reference: string, input: ArchiveInputT, ctx: OpsContext = {}): Promise<TicketResultDTO> {
  const now = nowOf(deps);
  const audit = auditOf(deps);
  return deps.db.$transaction(async (tx) => {
    const t = await loadVisibleTicket(tx, actor, reference, deps.policy);
    if (!can(actor.role, "ticket.archive", deps.policy)) throw new ForbiddenError();
    const updated = await applyVersioned(tx, t, input.version, { archivedAt: now, archivedByEmployeeId: actor.employeeId });
    await recordEvent(tx, { ticketId: t.id, type: "archived", actorEmployeeId: actor.employeeId, data: input.reason ? { reason: input.reason } : undefined });
    await audit(tx, { action: "ticket.archive", actorType: "user", actorEmployeeId: actor.employeeId, entityType: "ticket", entityId: t.id, ticketId: t.id, requestId: ctx.requestId, changes: { archivedAt: [null, now.toISOString()] } });
    return resultOf(updated);
  });
}
