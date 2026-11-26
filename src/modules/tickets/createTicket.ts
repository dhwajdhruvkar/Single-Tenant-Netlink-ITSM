import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import { enqueueJobs } from "@/modules/jobs/enqueue";
import { routeTicket } from "@/modules/assignment/routing";
import type { Actor } from "@/modules/identity/actor";
import { can } from "@/modules/identity/permissions";
import { atLeast } from "@/modules/identity/roleMapping";
import { computeSlaDues } from "@/modules/sla/policy";
import { systemClock, type Clock } from "@/platform/clock";
import { linkStagedAttachments } from "@/modules/attachments/service";
import { ConflictError, ForbiddenError, UnprocessableError } from "@/platform/errors";
import type { TicketCreatedDTO } from "./dto";
import { derivePriority, type Level, type Priority } from "./priority";
import { allocateTicketNumber, formatReference } from "./reference";
import { sanitizeTypeDetails } from "./typeDetails";

// The ONE ticket-creation service, used by both the employee self-service form and the agent-assisted form. The two HTTP
// endpoints only differ in how `requester` is resolved; every business rule lives here.

export interface CreateTicketCommand {
  type: "incident" | "service_request";
  categoryId?: string;
  subject: string;
  description: string;
  impact?: Level;
  urgency?: Level;
  contactPhone?: string;
  locationNote?: string;
  typeDetails?: unknown;
  attachmentIds: string[];
  /** `self` = the signed-in actor. `employee` = on behalf of a directory employee (loaded and re-validated server-side). */
  requester: { kind: "self" } | { kind: "employee"; employeeId: string };
  channel: "portal" | "phone" | "walk_in" | "email" | "teams" | "chat";
  priorityOverride?: { priority: Priority; reason: string };
  assignmentGroupId?: string;
  assigneeEmployeeId?: string;
  idempotencyKey?: string;
  requestId?: string;
}

export interface CreateTicketDeps {
  db: PrismaClient;
  clock?: Clock;
  /** Injectable for tests (e.g. to prove the whole creation rolls back if the audit write fails). */
  audit?: typeof writeAudit;
}

export interface CreateTicketResult {
  ticket: TicketCreatedDTO;
  replayed: boolean;
}

/** Stable hash of the request body, stored with the `created` event to detect an idempotency key reused with a different body. */
export function hashRequest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

const ticketInclude = {
  category: { select: { id: true, name: true } },
  assignmentGroup: { select: { id: true, name: true } },
  assignee: { select: { id: true, displayName: true } },
  createdBy: { select: { id: true, displayName: true } },
  requester: { select: { id: true, displayName: true, mail: true } },
} satisfies Prisma.TicketInclude;

type TicketWithRelations = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

function toDTO(t: TicketWithRelations): TicketCreatedDTO {
  return {
    id: t.id,
    reference: t.reference,
    number: t.number.toString(),
    type: t.type,
    status: t.status,
    subject: t.subject,
    priority: t.priority,
    priorityOverridden: t.priorityOverridden,
    impact: t.impact,
    urgency: t.urgency,
    channel: t.channel,
    category: t.category,
    requester: {
      id: t.requesterEmployeeId,
      displayName: t.requesterName,
      mail: t.requesterEmail,
      department: t.requesterDepartment,
      jobTitle: t.requesterJobTitle,
      location: t.requesterLocation,
    },
    createdBy: t.createdBy,
    onBehalf: t.requesterEmployeeId !== t.createdByEmployeeId,
    assignmentGroup: t.assignmentGroup,
    assignee: t.assignee,
    responseDueAt: t.responseDueAt?.toISOString() ?? null,
    resolveDueAt: t.resolveDueAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

async function findReplay(db: PrismaClient, creatorId: string, key: string, requestHash: string): Promise<CreateTicketResult | null> {
  const existing = await db.ticket.findUnique({
    where: { createdByEmployeeId_idempotencyKey: { createdByEmployeeId: creatorId, idempotencyKey: key } },
    include: { ...ticketInclude, events: { where: { type: "created" }, take: 1, select: { data: true } } },
  });
  if (!existing) return null;
  const storedHash = (existing.events[0]?.data as { requestHash?: string } | null)?.requestHash;
  if (storedHash && storedHash !== requestHash) {
    throw new ConflictError("This Idempotency-Key was already used with a different request.", { code: "idempotency_key_reused" });
  }
  return { ticket: toDTO(existing), replayed: true };
}

export async function createTicket(deps: CreateTicketDeps, actor: Actor, cmd: CreateTicketCommand): Promise<CreateTicketResult> {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? writeAudit;
  const onBehalfCommand = cmd.requester.kind === "employee";
  const requestHash = hashRequest({ ...cmd, idempotencyKey: undefined, requestId: undefined });

  // --- authorisation (defence in depth: the endpoints also check) ----------------------------------------------------
  if (onBehalfCommand ? !can(actor.role, "ticket.create.assisted") : !can(actor.role, "ticket.create.self")) throw new ForbiddenError();
  const agentOnly = Boolean(cmd.priorityOverride || cmd.assignmentGroupId || cmd.assigneeEmployeeId);
  if (agentOnly && !atLeast(actor.role, "agent")) throw new ForbiddenError("Only agents can set a priority override, group or assignee.");

  // --- idempotency ---------------------------------------------------------------------------------------------------
  if (cmd.idempotencyKey) {
    const replay = await findReplay(db, actor.employeeId, cmd.idempotencyKey, requestHash);
    if (replay) return replay;
  }

  // --- requester (always re-read from the database; never trust anything the client says about who they are) ------------
  const requesterId = cmd.requester.kind === "self" ? actor.employeeId : cmd.requester.employeeId;
  const requester = await db.employee.findUnique({
    where: { id: requesterId },
    include: { department: { select: { name: true } }, location: { select: { name: true } } },
  });
  if (!requester || !requester.isEligible || !requester.accountEnabled || requester.directoryDeletedAt) {
    throw new UnprocessableError("REQUESTER_NOT_ELIGIBLE", "The selected person cannot be a requester.");
  }

  // --- category / details --------------------------------------------------------------------------------------------
  let category: { id: string; defaultGroupId: string | null; defaultImpact: Level | null; defaultUrgency: Level | null } | null = null;
  if (cmd.categoryId) {
    const c = await db.category.findUnique({ where: { id: cmd.categoryId } });
    // An empty ticketTypes list means the category applies to every type.
    if (!c || !c.active || (c.ticketTypes.length > 0 && !c.ticketTypes.includes(cmd.type))) {
      throw new UnprocessableError("CATEGORY_INVALID", "The selected category is not available for this ticket type.");
    }
    category = c;
  }
  const typeDetails = sanitizeTypeDetails(cmd.type, cmd.typeDetails);

  // --- priority ------------------------------------------------------------------------------------------------------
  const impact: Level = cmd.impact ?? category?.defaultImpact ?? "medium";
  const urgency: Level = cmd.urgency ?? category?.defaultUrgency ?? "medium";
  const derived = derivePriority(impact, urgency);
  const priority: Priority = cmd.priorityOverride?.priority ?? derived;

  // --- routing -------------------------------------------------------------------------------------------------------
  const routing = await routeTicket(db, { explicitGroupId: cmd.assignmentGroupId, categoryDefaultGroupId: category?.defaultGroupId });
  if (cmd.assignmentGroupId) {
    const g = await db.assignmentGroup.findFirst({ where: { id: cmd.assignmentGroupId, active: true }, select: { id: true } });
    if (!g) throw new UnprocessableError("GROUP_INVALID", "The selected group is not available.");
  }
  if (cmd.assigneeEmployeeId) {
    const member = routing.groupId
      ? await db.assignmentGroupMember.findFirst({
          where: { groupId: routing.groupId, employeeId: cmd.assigneeEmployeeId, employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: null } },
          select: { employeeId: true },
        })
      : null;
    if (!member) throw new UnprocessableError("ASSIGNEE_NOT_IN_GROUP", "The assignee must be an active member of the ticket's group.");
  }

  // --- SLA -----------------------------------------------------------------------------------------------------------
  const createdAt = clock.now();
  const sla = await computeSlaDues(db, { priority, type: cmd.type, createdAt });

  const requesterLocation = cmd.locationNote ?? requester.location?.name ?? requester.officeLocationRaw ?? null;

  // --- one transaction: ticket + event + audit + outbox jobs ---------------------------------------------------------------
  try {
    const ticket = await db.$transaction(async (tx) => {
      const number = await allocateTicketNumber(tx);
      const created = await tx.ticket.create({
        data: {
          number,
          reference: formatReference(cmd.type, number),
          type: cmd.type,
          status: cmd.assigneeEmployeeId ? "assigned" : "new",
          channel: cmd.channel,
          subject: cmd.subject,
          description: cmd.description,
          categoryId: category?.id ?? null,
          impact,
          urgency,
          priority,
          priorityOverridden: Boolean(cmd.priorityOverride),
          priorityOverrideReason: cmd.priorityOverride?.reason ?? null,
          typeDetails: typeDetails ?? undefined,
          requesterEmployeeId: requester.id,
          createdByEmployeeId: actor.employeeId,
          requesterName: requester.displayName,
          requesterEmail: requester.mail ?? requester.userPrincipalName,
          requesterDepartment: requester.department?.name ?? requester.departmentRaw,
          requesterJobTitle: requester.jobTitle,
          requesterLocation,
          contactPhone: cmd.contactPhone ?? requester.businessPhone ?? requester.mobilePhone ?? null,
          assignmentGroupId: routing.groupId,
          assigneeEmployeeId: cmd.assigneeEmployeeId ?? null,
          slaPolicyId: sla.slaPolicyId,
          responseDueAt: sla.responseDueAt,
          resolveDueAt: sla.resolveDueAt,
          idempotencyKey: cmd.idempotencyKey ?? null,
          createdAt,
        },
        include: ticketInclude,
      });

      // Same transaction: a bad attachment id rolls back the ticket as well.
      await linkStagedAttachments(tx, { actorEmployeeId: actor.employeeId, ids: cmd.attachmentIds, ticketId: created.id, now: createdAt });

      await tx.ticketEvent.create({
        data: {
          ticketId: created.id,
          type: "created",
          actorEmployeeId: actor.employeeId,
          toValue: created.status,
          data: {
            channel: cmd.channel,
            onBehalf: requester.id !== actor.employeeId,
            routing: routing.source,
            derivedPriority: derived,
            attachmentCount: cmd.attachmentIds.length,
            ...(cmd.idempotencyKey ? { requestHash } : {}),
          },
        },
      });

      await audit(tx, {
        action: "ticket.create",
        actorType: "user",
        actorEmployeeId: actor.employeeId,
        entityType: "ticket",
        entityId: created.id,
        ticketId: created.id,
        requestId: cmd.requestId,
        changes: {
          reference: created.reference,
          channel: cmd.channel,
          requesterEmployeeId: requester.id,
          onBehalf: onBehalfCommand,
          priority,
          priorityOverridden: Boolean(cmd.priorityOverride),
          assignmentGroupId: routing.groupId,
        },
      });

      await enqueueJobs(tx, [
        { kind: "notify.ticket_created", dedupeKey: `${created.id}:created`, payload: { ticketId: created.id, recipientEmployeeId: requester.id } },
        {
          kind: "notify.ticket_assigned",
          dedupeKey: `${created.id}:assigned`,
          payload: { ticketId: created.id, assignmentGroupId: routing.groupId, assigneeEmployeeId: cmd.assigneeEmployeeId ?? null },
        },
      ]);

      return created;
    });
    return { ticket: toDTO(ticket), replayed: false };
  } catch (err) {
    // Two concurrent requests with the same key: the loser replays the winner's ticket.
    if (cmd.idempotencyKey && isUniqueViolation(err)) {
      const replay = await findReplay(db, actor.employeeId, cmd.idempotencyKey, requestHash);
      if (replay) return replay;
    }
    throw err;
  }
}
