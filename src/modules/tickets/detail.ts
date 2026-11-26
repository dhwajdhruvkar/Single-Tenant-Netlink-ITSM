import type { PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { slaStatus, type SlaStatus } from "@/modules/sla/status";
import { visibleTicketsWhere } from "./access";
import { loadTicketSettings } from "./ops";
import { assertCanTransition, OPEN_STATUSES, TRANSITIONS, type Status } from "./stateMachine";

export interface MessageDTO {
  id: string;
  authorName: string | null;
  authorKind: string;
  visibility: "public" | "internal";
  body: string;
  removed: boolean;
  createdAt: string;
  attachments: { id: string; fileName: string; sizeBytes: number }[];
}

export interface EventDTO {
  id: string;
  type: string;
  actorName: string | null;
  from: string | null;
  to: string | null;
  note: string | null;
  at: string;
}

export interface TicketDetailDTO {
  id: string;
  reference: string;
  version: number;
  type: string;
  status: string;
  holdReason: string | null;
  subject: string;
  description: string;
  priority: string;
  priorityOverridden: boolean;
  impact: string;
  urgency: string;
  channel: string;
  category: { id: string; name: string } | null;
  requester: { id: string; name: string; email: string | null; department: string | null; jobTitle: string | null; location: string | null };
  createdBy: { id: string; name: string };
  assignmentGroup: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  resolutionNotes: string | null;
  createdAt: string;
  updatedAt: string;
  responseDueAt: string | null;
  resolveDueAt: string | null;
  sla: SlaStatus;
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
  messages: MessageDTO[];
  events: EventDTO[];
  /** What THIS actor may do right now (computed on the server; the UI only mirrors it and the API enforces it again). */
  actions: { statuses: Status[]; canAssign: boolean; canEdit: boolean; canArchive: boolean; canReply: boolean; canNote: boolean };
}

type Db = Pick<PrismaClient, "ticket" | "attachment" | "ticketMessage" | "ticketEvent" | "companySetting" | "employee">;

/**
 * Full ticket for one viewer, or null when they may not see it (404). Internal notes, their attachments, internal events and agent-only
 * reasons are excluded **in the queries** for anyone who is not agent+, so they never reach the response for an employee.
 */
export async function getTicketDetail(db: Db, actor: Actor, reference: string, opts: { policy?: PolicyOptions; now?: Date } = {}): Promise<TicketDetailDTO | null> {
  const now = opts.now ?? new Date();
  const agent = can(actor.role, "ticket.note.internal", opts.policy);

  const t = await db.ticket.findFirst({
    where: { AND: [visibleTicketsWhere(actor, opts.policy), { reference }] },
    include: {
      category: { select: { id: true, name: true } },
      createdBy: { select: { id: true, displayName: true } },
      assignmentGroup: { select: { id: true, name: true } },
      assignee: { select: { id: true, displayName: true } },
    },
  });
  if (!t) return null;

  const messages = await db.ticketMessage.findMany({
    where: { ticketId: t.id, ...(agent ? {} : { visibility: "public" }) },
    orderBy: { createdAt: "asc" },
    include: { attachments: { where: { status: "linked" }, select: { id: true, fileName: true, sizeBytes: true } } },
  });
  const authorIds = [...new Set(messages.map((m) => m.authorEmployeeId).filter((x): x is string => !!x))];

  const events = await db.ticketEvent.findMany({
    where: { ticketId: t.id, ...(agent ? {} : { type: { notIn: ["internal_note_added"] } }) },
    orderBy: { createdAt: "asc" },
  });
  const actorIds = [...new Set(events.map((e) => e.actorEmployeeId).filter((x): x is string => !!x))];
  const nameIds = [...new Set([...authorIds, ...actorIds])];
  const people = new Map((nameIds.length ? await db.employee.findMany({ where: { id: { in: nameIds } }, select: { id: true, displayName: true } }) : []).map((p) => [p.id, p.displayName]));

  const attachments = await db.attachment.findMany({
    where: { ticketId: t.id, status: "linked", ...(agent ? {} : { OR: [{ messageId: null }, { message: { visibility: "public", deletedAt: null } }] }) },
    orderBy: { createdAt: "asc" },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true },
  });

  const settings = await loadTicketSettings(db);
  const ctx = { now, reopenWindowDays: settings.reopenWindowDays, policy: opts.policy };
  const statuses = TRANSITIONS[t.status as Status].filter((to) => {
    if (to === "assigned") return false;
    try {
      assertCanTransition(actor, t as never, to, ctx);
      return true;
    } catch {
      return false;
    }
  });
  const open = OPEN_STATUSES.includes(t.status as Status);

  return {
    id: t.id, reference: t.reference, version: t.version, type: t.type, status: t.status, holdReason: t.holdReason, subject: t.subject, description: t.description,
    priority: t.priority, priorityOverridden: t.priorityOverridden, impact: t.impact, urgency: t.urgency, channel: t.channel, category: t.category,
    requester: { id: t.requesterEmployeeId, name: t.requesterName, email: t.requesterEmail, department: t.requesterDepartment, jobTitle: t.requesterJobTitle, location: t.requesterLocation },
    createdBy: { id: t.createdBy.id, name: t.createdBy.displayName },
    assignmentGroup: t.assignmentGroup, assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.displayName } : null,
    resolutionNotes: t.resolutionNotes, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
    responseDueAt: t.responseDueAt?.toISOString() ?? null, resolveDueAt: t.resolveDueAt?.toISOString() ?? null,
    sla: slaStatus(t, now), attachments,
    messages: messages.map((m) => ({
      id: m.id, authorName: m.authorEmployeeId ? people.get(m.authorEmployeeId) ?? null : null, authorKind: m.authorKind, visibility: m.visibility,
      body: m.deletedAt ? "" : m.body, removed: m.deletedAt !== null, createdAt: m.createdAt.toISOString(),
      attachments: m.deletedAt ? [] : m.attachments,
    })),
    events: events.map((e) => {
      const d = (e.data ?? {}) as { reason?: unknown; holdReason?: unknown };
      return {
        id: e.id, type: e.type, actorName: e.actorEmployeeId ? people.get(e.actorEmployeeId) ?? null : null, from: e.fromValue, to: e.toValue,
        // free-text reasons written by agents are agent-only; requesters see the fact of the change, not the note
        note: agent && typeof d.reason === "string" ? d.reason : null, at: e.createdAt.toISOString(),
      };
    }),
    actions: {
      statuses,
      canAssign: open && can(actor.role, "ticket.assign.self", opts.policy),
      canEdit: open && can(actor.role, "ticket.update", opts.policy),
      canArchive: can(actor.role, "ticket.archive", opts.policy),
      canReply: t.status !== "closed" && t.status !== "cancelled",
      canNote: agent && t.status !== "closed" && t.status !== "cancelled",
    },
  };
}
