import { atLeast, type AppRole } from "./roleMapping";

// Server-enforced permission matrix (docs/planning/DATABASE_DESIGN.md section 3.2). UI hiding is cosmetic only.
// Permissions flagged "record-level" are further narrowed by policies.ts (own / created / queue) -- holding the permission
// is necessary, not sufficient.

export const PERMISSIONS = [
  "ticket.view.own", // record-level: requester
  "ticket.view.created", // record-level: creator
  "ticket.view.queue", // record-level: assigned / own group / triage
  "ticket.view.all",
  "ticket.create.self",
  "ticket.create.assisted",
  "directory.search",
  "ticket.reply.public", // record-level
  "ticket.note.internal",
  "ticket.assign.self",
  "ticket.reassign.group",
  "ticket.reassign.any",
  "ticket.edit.priority", // override needs a reason
  "ticket.edit.category",
  "ticket.resolve",
  "ticket.confirm_reopen", // record-level: requester, or agent+
  "ticket.close",
  "ticket.cancel", // record-level: own/created while `new`, or agent+
  "ticket.escalate",
  "approval.decide", // record-level: named approver
  "ticket.archive",
  "dashboard.own",
  "reports.team",
  "reports.all",
  "audit.view",
  "audit.ticket_timeline",
  "config.manage",
  "config.group_membership",
  "users.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

type Rule = AppRole | "all" | "none";

/** Minimum role that holds each permission (roles are a strict hierarchy: employee < submitter < agent < manager < admin). */
const MINIMUM: Record<Permission, Rule> = {
  "ticket.view.own": "all",
  "ticket.view.created": "all",
  "ticket.view.queue": "agent",
  "ticket.view.all": "manager", // agents: see PolicyOptions.agentsViewAllTickets ([OPEN], default off)
  "ticket.create.self": "all",
  "ticket.create.assisted": "submitter",
  "directory.search": "submitter",
  "ticket.reply.public": "all",
  "ticket.note.internal": "agent",
  "ticket.assign.self": "agent",
  "ticket.reassign.group": "agent",
  "ticket.reassign.any": "manager",
  "ticket.edit.priority": "agent",
  "ticket.edit.category": "agent",
  "ticket.resolve": "agent",
  "ticket.confirm_reopen": "all",
  "ticket.close": "agent",
  "ticket.cancel": "all",
  "ticket.escalate": "agent",
  "approval.decide": "all",
  "ticket.archive": "manager",
  "dashboard.own": "all",
  "reports.team": "agent",
  "reports.all": "manager",
  "audit.view": "manager",
  "audit.ticket_timeline": "agent",
  "config.manage": "admin",
  "config.group_membership": "admin", // [OPEN] managers may be allowed to manage membership; default admin only
  "users.manage": "admin",
};

export interface PolicyOptions {
  /** [OPEN] Whether agents may view all tickets regardless of queue. Default false. */
  agentsViewAllTickets?: boolean;
}

export function can(role: AppRole, permission: Permission, options: PolicyOptions = {}): boolean {
  if (permission === "ticket.view.all" && role === "agent") return options.agentsViewAllTickets === true;
  const rule = MINIMUM[permission];
  if (rule === "all") return true;
  if (rule === "none") return false;
  return atLeast(role, rule);
}
