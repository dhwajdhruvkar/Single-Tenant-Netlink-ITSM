import { describe, expect, it } from "vitest";
import { can, PERMISSIONS, type Permission } from "@/modules/identity/permissions";
import type { AppRole } from "@/modules/identity/roleMapping";

const ROLES: AppRole[] = ["employee", "submitter", "agent", "manager", "admin"];
const Y = true;
const N = false;

// Independent transcription of docs/planning/DATABASE_DESIGN.md section 3.2.  Columns: employee, submitter, agent, manager, admin.
const EXPECTED: Record<Permission, [boolean, boolean, boolean, boolean, boolean]> = {
  "ticket.view.own": [Y, Y, Y, Y, Y],
  "ticket.view.created": [Y, Y, Y, Y, Y],
  "ticket.view.queue": [N, N, Y, Y, Y],
  "ticket.view.all": [N, N, N, Y, Y], // agent: [OPEN], default off
  "ticket.create.self": [Y, Y, Y, Y, Y],
  "ticket.create.assisted": [N, Y, Y, Y, Y],
  "directory.search": [N, Y, Y, Y, Y],
  "ticket.reply.public": [Y, Y, Y, Y, Y],
  "ticket.note.internal": [N, N, Y, Y, Y],
  "ticket.assign.self": [N, N, Y, Y, Y],
  "ticket.reassign.group": [N, N, Y, Y, Y],
  "ticket.reassign.any": [N, N, N, Y, Y],
  "ticket.edit.priority": [N, N, Y, Y, Y],
  "ticket.edit.category": [N, N, Y, Y, Y],
  "ticket.update": [N, N, Y, Y, Y],
  "ticket.resolve": [N, N, Y, Y, Y],
  // DELIBERATE DEVIATION from Doc C (which shows "-" for submitter): roles are a hierarchy and a submitter is an employee
  // plus extra rights, so a submitter keeps the employee right to confirm/reopen their OWN tickets (record-level rule).
  "ticket.confirm_reopen": [Y, Y, Y, Y, Y],
  "ticket.close": [N, N, Y, Y, Y],
  "ticket.cancel": [Y, Y, Y, Y, Y],
  "ticket.escalate": [N, N, Y, Y, Y],
  "approval.decide": [Y, Y, Y, Y, Y],
  "ticket.archive": [N, N, N, Y, Y],
  "dashboard.own": [Y, Y, Y, Y, Y],
  "reports.team": [N, N, Y, Y, Y],
  "reports.all": [N, N, N, Y, Y],
  "audit.view": [N, N, N, Y, Y],
  "audit.ticket_timeline": [N, N, Y, Y, Y],
  "config.manage": [N, N, N, N, Y],
  "config.group_membership": [N, N, N, N, Y],
  "users.manage": [N, N, N, N, Y],
};

describe("permission matrix", () => {
  it("covers every permission exactly once", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const permission of PERMISSIONS) {
    it(`${permission}`, () => {
      const row = EXPECTED[permission];
      ROLES.forEach((role, i) => {
        expect(can(role, permission), `${role} / ${permission}`).toBe(row[i]);
      });
    });
  }

  it("lets agents view all tickets only when the [OPEN] option is on", () => {
    expect(can("agent", "ticket.view.all")).toBe(false);
    expect(can("agent", "ticket.view.all", { agentsViewAllTickets: true })).toBe(true);
    expect(can("employee", "ticket.view.all", { agentsViewAllTickets: true })).toBe(false);
  });
});
