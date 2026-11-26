import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import type { AppRole } from "@/modules/identity/roleMapping";
import { assertCanTransition, isAllowedTransition, STATUSES, TRANSITIONS, type Status, type TransitionFacts } from "@/modules/tickets/stateMachine";

const NOW = new Date("2026-03-10T12:00:00Z");
const ctx = { now: NOW, reopenWindowDays: 7 };
const actor = (role: AppRole, id = "me", groupIds: string[] = ["g"]): Actor => ({ employeeId: id, userAccountId: "ua", role, groupIds, triageGroupIds: [] });
const facts = (status: Status, over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  status, requesterEmployeeId: "req", createdByEmployeeId: "req", assigneeEmployeeId: null, assignmentGroupId: "g", resolvedAt: null, ...over,
});

// The roadmap's table, transcribed independently.
const EXPECTED: Record<Status, Status[]> = {
  new: ["assigned", "in_progress", "on_hold", "resolved", "cancelled"],
  assigned: ["in_progress", "on_hold", "resolved", "cancelled"],
  in_progress: ["assigned", "on_hold", "resolved", "cancelled"],
  on_hold: ["assigned", "in_progress", "resolved", "cancelled"],
  resolved: ["in_progress", "closed"],
  closed: [],
  cancelled: [],
};

describe("transition table", () => {
  it("matches the roadmap exactly, for every from x to pair", () => {
    for (const from of STATUSES) for (const to of STATUSES) {
      expect(isAllowedTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
    }
    expect(TRANSITIONS).toEqual(EXPECTED);
  });
  it("closed and cancelled are terminal", () => {
    for (const to of STATUSES) {
      expect(isAllowedTransition("closed", to)).toBe(false);
      expect(isAllowedTransition("cancelled", to)).toBe(false);
    }
  });
  it("no status can move to itself", () => {
    for (const s of STATUSES) expect(isAllowedTransition(s, s)).toBe(false);
  });
});

describe("illegal transitions are 409 for everybody, including managers", () => {
  for (const from of STATUSES) for (const to of STATUSES) {
    if (EXPECTED[from].includes(to) || to === "assigned") continue;
    it(`${from} -> ${to}`, () => {
      expect(() => assertCanTransition(actor("admin"), facts(from), to, ctx)).toThrow(expect.objectContaining({ status: 409, details: expect.objectContaining({ code: "ILLEGAL_TRANSITION" }) }));
    });
  }
});

describe("who may do what", () => {
  it("agents may start, hold, resolve and cancel tickets they can see", () => {
    const a = actor("agent");
    for (const [from, to] of [["new", "in_progress"], ["assigned", "on_hold"], ["in_progress", "resolved"], ["on_hold", "in_progress"], ["new", "cancelled"], ["in_progress", "cancelled"], ["on_hold", "cancelled"]] as const) {
      expect(() => assertCanTransition(a, facts(from), to, ctx), `${from}->${to}`).not.toThrow();
    }
  });

  it("an agent outside the ticket's queue gets 404, not 403", () => {
    expect(() => assertCanTransition(actor("agent", "x", []), facts("new"), "in_progress", ctx)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("employees and submitters cannot start, hold or resolve even their own ticket", () => {
    for (const role of ["employee", "submitter"] as const) {
      const a = actor(role, "req");
      for (const to of ["in_progress", "on_hold", "resolved"] as const) {
        expect(() => assertCanTransition(a, facts("new"), to, ctx), `${role} ${to}`).toThrow(expect.objectContaining({ status: 403 }));
      }
    }
  });

  it("'assigned' can only be set through the assignment action", () => {
    expect(() => assertCanTransition(actor("manager"), facts("new"), "assigned", ctx)).toThrow(expect.objectContaining({ status: 422, code: "USE_ASSIGNMENT" }));
  });

  it("the requester may cancel while the ticket is new, but not afterwards", () => {
    expect(() => assertCanTransition(actor("employee", "req"), facts("new"), "cancelled", ctx)).not.toThrow();
    expect(() => assertCanTransition(actor("submitter", "creator"), facts("new", { createdByEmployeeId: "creator" }), "cancelled", ctx)).not.toThrow();
    for (const s of ["assigned", "in_progress", "on_hold"] as const) {
      expect(() => assertCanTransition(actor("employee", "req"), facts(s), "cancelled", ctx), s).toThrow(expect.objectContaining({ status: 403 }));
    }
  });

  it("an unrelated employee sees 404 for any action", () => {
    expect(() => assertCanTransition(actor("employee", "stranger"), facts("new"), "cancelled", ctx)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("the requester confirms a resolved ticket (closed); a submitter-creator who is not the requester cannot", () => {
    expect(() => assertCanTransition(actor("employee", "req"), facts("resolved", { resolvedAt: NOW }), "closed", ctx)).not.toThrow();
    expect(() => assertCanTransition(actor("submitter", "creator"), facts("resolved", { createdByEmployeeId: "creator", resolvedAt: NOW }), "closed", ctx)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => assertCanTransition(actor("agent"), facts("resolved", { resolvedAt: NOW }), "closed", ctx)).not.toThrow();
  });

  describe("reopening", () => {
    const resolvedDaysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    it("the requester may reopen within the window", () => {
      expect(() => assertCanTransition(actor("employee", "req"), facts("resolved", { resolvedAt: resolvedDaysAgo(6.9) }), "in_progress", ctx)).not.toThrow();
    });
    it("the requester may not reopen after the window (409 REOPEN_WINDOW_EXPIRED)", () => {
      expect(() => assertCanTransition(actor("employee", "req"), facts("resolved", { resolvedAt: resolvedDaysAgo(7.1) }), "in_progress", ctx)).toThrow(expect.objectContaining({ status: 409, details: expect.objectContaining({ code: "REOPEN_WINDOW_EXPIRED" }) }));
    });
    it("a missing resolvedAt counts as expired for requesters", () => {
      expect(() => assertCanTransition(actor("employee", "req"), facts("resolved"), "in_progress", ctx)).toThrow(expect.objectContaining({ status: 409 }));
    });
    it("agents may reopen at any time; the window is configurable", () => {
      expect(() => assertCanTransition(actor("agent"), facts("resolved", { resolvedAt: resolvedDaysAgo(400) }), "in_progress", ctx)).not.toThrow();
      expect(() => assertCanTransition(actor("employee", "req"), facts("resolved", { resolvedAt: resolvedDaysAgo(10) }), "in_progress", { ...ctx, reopenWindowDays: 14 })).not.toThrow();
    });
    it("only the requester (not the creator) may reopen as a non-agent", () => {
      expect(() => assertCanTransition(actor("submitter", "creator"), facts("resolved", { createdByEmployeeId: "creator", resolvedAt: NOW }), "in_progress", ctx)).toThrow(expect.objectContaining({ status: 403 }));
    });
  });
});
