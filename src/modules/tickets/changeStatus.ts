import { z } from "zod";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import type { Actor } from "@/modules/identity/actor";
import { calendarForPolicy } from "@/modules/sla/policy";
import { pausePatch } from "@/modules/sla/pause";
import { ValidationError } from "@/platform/errors";
import { auditOf, applyVersioned, loadTicketSettings, loadVisibleTicket, nowOf, recordEvent, resultOf, type OpsContext, type OpsDeps, type TicketResultDTO } from "./ops";
import { assertCanTransition, HOLD_REASONS, STATUSES, type Status } from "./stateMachine";

export const StatusChange = z
  .object({
    version: z.number().int().min(0),
    to: z.enum(STATUSES),
    holdReason: z.enum(HOLD_REASONS).optional(),
    resolutionCode: z.string().trim().min(1).max(60).optional(),
    resolutionNotes: z.string().trim().min(1).max(10000).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type StatusChangeInput = z.infer<typeof StatusChange>;

/** Move a ticket along the lifecycle (see stateMachine.ts). One transaction: ticket + event + audit + outbox job. */
export async function changeStatus(deps: OpsDeps, actor: Actor, reference: string, input: StatusChangeInput, ctx: OpsContext = {}): Promise<TicketResultDTO> {
  const now = nowOf(deps);
  const audit = auditOf(deps);

  return deps.db.$transaction(async (tx) => {
    const t = await loadVisibleTicket(tx, actor, reference, deps.policy);
    const settings = await loadTicketSettings(tx);
    const from = t.status as Status;
    assertCanTransition(actor, t as never, input.to, { now, reopenWindowDays: settings.reopenWindowDays, policy: deps.policy });

    if (input.to === "on_hold" && !input.holdReason) throw new ValidationError("A hold reason is required when putting a ticket on hold.");
    if (input.to !== "on_hold" && input.holdReason) throw new ValidationError("A hold reason is only valid when putting a ticket on hold.");
    if (input.to !== "resolved" && (input.resolutionCode || input.resolutionNotes)) throw new ValidationError("Resolution details are only valid when resolving a ticket.");

    const reopening = from === "resolved" && input.to === "in_progress";
    const calendar = await calendarForPolicy(tx, t.slaPolicyId);
    const pause = pausePatch(
      { status: t.status, slaPausedAt: t.slaPausedAt, slaPausedMinutes: t.slaPausedMinutes, responseDueAt: t.responseDueAt, resolveDueAt: t.resolveDueAt, firstRespondedAt: t.firstRespondedAt },
      { status: input.to, holdReason: input.holdReason ?? null },
      now,
      calendar,
      settings.pausingHoldReasons,
    );

    const updated = await applyVersioned(tx, t, input.version, {
      status: input.to,
      holdReason: input.to === "on_hold" ? input.holdReason : null,
      ...(input.to === "resolved"
        ? {
            resolvedAt: now,
            resolvedByEmployeeId: actor.employeeId,
            resolutionCode: input.resolutionCode ?? null,
            resolutionNotes: input.resolutionNotes ?? null,
            // Resolving without any earlier public reply still counts as the first response.
            ...(t.firstRespondedAt === null ? { firstRespondedAt: now } : {}),
          }
        : {}),
      ...(reopening ? { resolvedAt: null, resolvedByEmployeeId: null, resolutionCode: null, resolutionNotes: null, reopenCount: { increment: 1 } } : {}),
      ...(input.to === "closed" ? { closedAt: now } : {}),
      ...pause,
    });

    await recordEvent(tx, {
      ticketId: t.id,
      type: reopening ? "reopened" : "status_changed",
      actorEmployeeId: actor.employeeId,
      fromValue: from,
      toValue: input.to,
      data: { ...(input.holdReason ? { holdReason: input.holdReason } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(input.resolutionCode ? { resolutionCode: input.resolutionCode } : {}) },
    });
    await audit(tx, {
      action: reopening ? "ticket.reopen" : "ticket.status",
      actorType: "user",
      actorEmployeeId: actor.employeeId,
      entityType: "ticket",
      entityId: t.id,
      ticketId: t.id,
      requestId: ctx.requestId,
      changes: { status: [from, input.to], ...(input.holdReason ? { holdReason: [null, input.holdReason] } : {}) },
    });
    await enqueueJobs(tx, [{ kind: "notify.ticket_status_changed", dedupeKey: `${t.id}:v${updated.version}:status`, payload: { ticketId: t.id, from, to: input.to } }]);
    return resultOf(updated);
  });
}
