import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import { canViewInternal, canViewTicket, type TicketAccessFacts } from "@/modules/identity/policies";
import type { AppRole } from "@/modules/identity/roleMapping";

const ME = "me";
const OTHER = "other";
const G_MINE = "g-mine";
const G_OTHER = "g-other";
const G_TRIAGE = "g-triage";

const actor = (role: AppRole, over: Partial<Actor> = {}): Actor => ({
  employeeId: ME, userAccountId: "ua", role, groupIds: [], triageGroupIds: [], ...over,
});
const ticket = (over: Partial<TicketAccessFacts> = {}): TicketAccessFacts => ({
  requesterEmployeeId: OTHER, createdByEmployeeId: OTHER, assigneeEmployeeId: null, assignmentGroupId: G_OTHER, ...over,
});

describe("canViewTicket", () => {
  const roles: AppRole[] = ["employee", "submitter", "agent", "manager", "admin"];

  it("everyone sees tickets they requested or created", () => {
    for (const role of roles) {
      expect(canViewTicket(actor(role), ticket({ requesterEmployeeId: ME }))).toBe(true);
      expect(canViewTicket(actor(role), ticket({ createdByEmployeeId: ME }))).toBe(true);
    }
  });

  it("employees and submitters never see other people's tickets, even if assigned or in the group", () => {
    for (const role of ["employee", "submitter"] as const) {
      const a = actor(role, { groupIds: [G_OTHER] });
      expect(canViewTicket(a, ticket({ assigneeEmployeeId: ME }))).toBe(false);
      expect(canViewTicket(a, ticket())).toBe(false);
    }
  });

  it("managers and admins see everything", () => {
    for (const role of ["manager", "admin"] as const) expect(canViewTicket(actor(role), ticket())).toBe(true);
  });

  it("agents see tickets assigned to them", () => {
    expect(canViewTicket(actor("agent"), ticket({ assigneeEmployeeId: ME }))).toBe(true);
  });

  it("agents see their groups' queues but not other groups'", () => {
    const a = actor("agent", { groupIds: [G_MINE] });
    expect(canViewTicket(a, ticket({ assignmentGroupId: G_MINE }))).toBe(true);
    expect(canViewTicket(a, ticket({ assignmentGroupId: G_OTHER }))).toBe(false);
  });

  it("only triage-group agents see tickets that have no group", () => {
    expect(canViewTicket(actor("agent", { groupIds: [G_MINE] }), ticket({ assignmentGroupId: null }))).toBe(false);
    expect(canViewTicket(actor("agent", { groupIds: [G_TRIAGE], triageGroupIds: [G_TRIAGE] }), ticket({ assignmentGroupId: null }))).toBe(true);
  });

  it("an agent outside the group cannot see a ticket just because it is unassigned", () => {
    expect(canViewTicket(actor("agent"), ticket({ assigneeEmployeeId: null, assignmentGroupId: G_OTHER }))).toBe(false);
  });

  it("agents see everything only with the [OPEN] option", () => {
    expect(canViewTicket(actor("agent"), ticket(), { agentsViewAllTickets: true })).toBe(true);
  });
});

describe("canViewInternal", () => {
  it("requires agent+ and ticket visibility", () => {
    expect(canViewInternal(actor("employee"), ticket({ requesterEmployeeId: ME }))).toBe(false);
    expect(canViewInternal(actor("submitter"), ticket({ createdByEmployeeId: ME }))).toBe(false);
    expect(canViewInternal(actor("agent", { groupIds: [G_MINE] }), ticket({ assignmentGroupId: G_MINE }))).toBe(true);
    expect(canViewInternal(actor("agent"), ticket())).toBe(false);
    expect(canViewInternal(actor("manager"), ticket())).toBe(true);
  });

  it("an agent who is also the requester sees internal notes on their own ticket", () => {
    expect(canViewInternal(actor("agent"), ticket({ requesterEmployeeId: ME }))).toBe(true);
  });
});
