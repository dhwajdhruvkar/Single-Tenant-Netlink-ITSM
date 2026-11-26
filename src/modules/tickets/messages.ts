import { z } from "zod";
import { linkStagedAttachments } from "@/modules/attachments/service";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { calendarForPolicy } from "@/modules/sla/policy";
import { pausePatch } from "@/modules/sla/pause";
import { ConflictError, ForbiddenError } from "@/platform/errors";
import { loadTicketSettings, loadVisibleTicket, nowOf, recordEvent, type OpsDeps } from "./ops";
import { TERMINAL, type Status } from "./stateMachine";

export const MessageInput = z
  .object({
    body: z.string().trim().min(1).max(10000),
    visibility: z.enum(["public", "internal"]).default("public"),
    attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict();
export type MessageInputT = z.infer<typeof MessageInput>;

export interface MessageResultDTO {
  id: string;
  ticketId: string;
  reference: string;
  visibility: "public" | "internal";
  /** Present when the message changed the ticket's status (an employee reply ends an awaiting-requester hold). */
  status: string;
}

/**
 * Add a conversation message.
 *  - `internal` notes need agent+ (an employee sending one is 403); they are never visible to, or notified to, the requester.
 *  - The first public reply by someone other than the requester records `firstRespondedAt`.
 *  - A reply by the requester/creator while the ticket is on hold *awaiting requester* returns it to `in_progress` and resumes the SLA clock.
 *  - Attachments are linked to the message in the same transaction.
 */
export async function addMessage(deps: OpsDeps, actor: Actor, reference: string, input: MessageInputT): Promise<MessageResultDTO> {
  const now = nowOf(deps);
  const agent = can(actor.role, "ticket.note.internal", deps.policy);
  if (input.visibility === "internal" && !agent) throw new ForbiddenError("Only agents can add internal notes.");

  return deps.db.$transaction(async (tx) => {
    const t = await loadVisibleTicket(tx, actor, reference, deps.policy);
    if (TERMINAL.includes(t.status as Status)) throw new ConflictError("This ticket is closed. Open a new ticket if you still need help.", { code: "TICKET_FINAL" });

    const message = await tx.ticketMessage.create({
      data: { ticketId: t.id, authorEmployeeId: actor.employeeId, authorKind: agent ? "agent" : "employee", visibility: input.visibility, body: input.body, createdAt: now },
    });
    await linkStagedAttachments(tx, { actorEmployeeId: actor.employeeId, ids: input.attachmentIds, ticketId: t.id, messageId: message.id, now });

    const data: Record<string, unknown> = { updatedAt: now };
    let versionBump = false;
    const byRequesterSide = !agent && (t.requesterEmployeeId === actor.employeeId || t.createdByEmployeeId === actor.employeeId);
    const fromOthers = actor.employeeId !== t.requesterEmployeeId;

    if (input.visibility === "public" && agent && fromOthers && t.firstRespondedAt === null) data.firstRespondedAt = now;

    let status = t.status;
    if (input.visibility === "public" && byRequesterSide && t.status === "on_hold" && t.holdReason === "awaiting_requester") {
      const settings = await loadTicketSettings(tx);
      const calendar = await calendarForPolicy(tx, t.slaPolicyId);
      Object.assign(
        data,
        { status: "in_progress", holdReason: null },
        pausePatch(
          { status: t.status, slaPausedAt: t.slaPausedAt, slaPausedMinutes: t.slaPausedMinutes, responseDueAt: t.responseDueAt, resolveDueAt: t.resolveDueAt, firstRespondedAt: t.firstRespondedAt },
          { status: "in_progress", holdReason: null }, now, calendar, settings.pausingHoldReasons,
        ),
      );
      status = "in_progress";
      versionBump = true;
    }

    await tx.ticket.update({ where: { id: t.id }, data: { ...data, ...(versionBump ? { version: { increment: 1 } } : {}) } as never });

    await recordEvent(tx, {
      ticketId: t.id,
      type: input.visibility === "internal" ? "internal_note_added" : "message_added",
      actorEmployeeId: actor.employeeId,
      data: { messageId: message.id, attachments: input.attachmentIds.length },
    });
    if (status !== t.status) await recordEvent(tx, { ticketId: t.id, type: "status_changed", actorEmployeeId: actor.employeeId, fromValue: t.status, toValue: status, data: { via: "requester_reply" } });
    // Recipients are decided by the notification job; it must never notify the requester about an internal note.
    await enqueueJobs(tx, [{ kind: "notify.ticket_message", dedupeKey: `message:${message.id}`, payload: { ticketId: t.id, messageId: message.id, visibility: input.visibility } }]);

    return { id: message.id, ticketId: t.id, reference: t.reference, visibility: input.visibility, status };
  });
}
