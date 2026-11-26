import { describe, expect, it } from "vitest";
import { derivePriority, PRIORITY_ORDER, type Level } from "@/modules/tickets/priority";

// Impact x urgency for all 9 combinations. The original 5-level matrix is collapsed into p1..p4 (low + very_low -> p4).
const CASES: Array<[Level, Level, string]> = [
  ["high", "high", "p1"],
  ["high", "medium", "p2"],
  ["medium", "high", "p2"],
  ["high", "low", "p3"],
  ["medium", "medium", "p3"],
  ["low", "high", "p3"],
  ["medium", "low", "p4"],
  ["low", "medium", "p4"],
  ["low", "low", "p4"],
];

describe("derivePriority", () => {
  for (const [impact, urgency, expected] of CASES) {
    it(`${impact} impact x ${urgency} urgency -> ${expected}`, () => expect(derivePriority(impact, urgency)).toBe(expected));
  }
  it("is symmetric in impact and urgency", () => {
    for (const a of ["low", "medium", "high"] as const) for (const b of ["low", "medium", "high"] as const) expect(derivePriority(a, b)).toBe(derivePriority(b, a));
  });
  it("exposes the priority order", () => expect(PRIORITY_ORDER).toEqual(["p1", "p2", "p3", "p4"]));
});
