import { z } from "zod";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { recomputeSlaDues } from "@/modules/sla/policy";
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from "@/platform/errors";
import { auditOf, applyVersioned, loadVisibleTicket, recordEvent, resultOf, type OpsContext, type OpsDeps, type TicketResultDTO } from "./ops";
import { derivePriority, type Level, type Priority } from "./priority";
import { TERMINAL, type Status } from "./stateMachine";

export const TicketPatch = z
  .object({
    version: z.number().int().min(0),
    priority: z.enum(["p1", "p2", "p3", "p4"]).nullable().optional(), // a value overrides; null clears the override
    impact: z.enum(["low", "medium", "high"]).optional(),
    urgency: z.enum(["low", "medium", "high"]).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    type: z.enum(["incident", "service_request"]).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type TicketPatchInput = z.infer<typeof TicketPatch>;

/** Edit priority / impact / urgency / category / type (agent+). Priority overrides need a reason; SLA due dates follow the result. */
export async function updateTicket(deps: OpsDeps, actor: Actor, reference: string, input: TicketPatchInput, ctx: OpsContext = {}): Promise<TicketResultDTO> {
  const { version, reason, ...fields } = input;
  if (Object.values(fields).every((v) => v === undefined)) throw new ValidationError("Nothing to change.");
  const audit = auditOf(deps);

  return deps.db.$transaction(async (tx) => {
    const t = await loadVisibleTicket(tx, actor, reference, deps.policy);
    if (!can(actor.role, "ticket.update", deps.policy)) throw new ForbiddenError();
    if (TERMINAL.includes(t.status as Status)) throw new ConflictError("A closed or cancelled ticket cannot be edited.", { code: "TICKET_FINAL" });

    const changes: Record<string, [unknown, unknown]> = {};
    const data: Record<string, unknown> = {};
    const events: { type: string; from: string | null; to: string | null; data?: Record<string, unknown> }[] = [];

    const type = fields.type ?? t.type;
    if (fields.type !== undefined && fields.type !== t.type) {
      changes.type = [t.type, fields.type];
      data.type = fields.type;
      data.typeDetails = null; // details are type-specific; keep nothing that no longer applies. The reference stays as issued.
      events.push({ type: "type_changed", from: t.type, to: fields.type });
    }

    if (fields.categoryId !== undefined || data.type !== undefined) {
      const categoryId = fields.categoryId !== undefined ? fields.categoryId : t.categoryId;
      if (categoryId) {
        const c = await tx.category.findUnique({ where: { id: categoryId } });
        if (!c || !c.active || (c.ticketTypes.length > 0 && !c.ticketTypes.includes(type))) {
          throw new UnprocessableError("CATEGORY_INVALID", "The selected category is not available for this ticket type.");
        }
      }
      if (categoryId !== t.categoryId) {
        changes.categoryId = [t.categoryId, categoryId];
        data.categoryId = categoryId;
        events.push({ type: "category_changed", from: t.categoryId, to: categoryId });
      }
    }

    const impact: Level = fields.impact ?? t.impact;
    const urgency: Level = fields.urgency ?? t.urgency;
    if (impact !== t.impact) { changes.impact = [t.impact, impact]; data.impact = impact; }
    if (urgency !== t.urgency) { changes.urgency = [t.urgency, urgency]; data.urgency = urgency; }

    // Priority: an explicit value is an override (reason required); null clears it; otherwise follow impact x urgency unless overridden.
    let priority: Priority = t.priority;
    let overridden = t.priorityOverridden;
    let overrideReason = t.priorityOverrideReason;
    if (fields.priority) {
      if (!reason) throw new ValidationError("A reason is required to override the priority.");
      priority = fields.priority; overridden = true; overrideReason = reason;
    } else if (fields.priority === null) {
      priority = derivePriority(impact, urgency); overridden = false; overrideReason = null;
    } else if (!overridden && (impact !== t.impact || urgency !== t.urgency)) {
      priority = derivePriority(impact, urgency);
    }
    if (priority !== t.priority) {
      changes.priority = [t.priority, priority];
      events.push({ type: "priority_changed", from: t.priority, to: priority, data: { overridden, ...(reason && fields.priority ? { reason } : {}) } });
    }
    if (overridden !== t.priorityOverridden || overrideReason !== t.priorityOverrideReason) {
      data.priorityOverridden = overridden;
      data.priorityOverrideReason = overrideReason;
    }
    if (priority !== t.priority) data.priority = priority;

    if (Object.keys(changes).length === 0 && Object.keys(data).length === 0) throw new ValidationError("Nothing to change.");

    // SLA follows priority and type.
    if (data.priority !== undefined || data.type !== undefined) {
      const sla = await recomputeSlaDues(tx, { priority, type, createdAt: t.createdAt, slaPausedMinutes: t.slaPausedMinutes });
      data.slaPolicyId = sla.slaPolicyId;
      data.responseDueAt = t.firstRespondedAt ? t.responseDueAt : sla.responseDueAt;
      data.resolveDueAt = sla.resolveDueAt;
    }

    const updated = await applyVersioned(tx, t, version, data);
    for (const e of events) await recordEvent(tx, { ticketId: t.id, type: e.type, actorEmployeeId: actor.employeeId, fromValue: e.from, toValue: e.to, data: e.data as never });
    await audit(tx, { action: "ticket.update", actorType: "user", actorEmployeeId: actor.employeeId, entityType: "ticket", entityId: t.id, ticketId: t.id, requestId: ctx.requestId, changes });
    if (changes.priority) await enqueueJobs(tx, [{ kind: "notify.ticket_priority_changed", dedupeKey: `${t.id}:v${updated.version}:priority`, payload: { ticketId: t.id, from: t.priority, to: priority } }]);
    return resultOf(updated);
  });
}
