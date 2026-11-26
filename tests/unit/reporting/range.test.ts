import { describe, expect, it } from "vitest";
import { parseRange } from "@/modules/reporting/range";
import { daysBetween } from "@/modules/reporting/queries";

const now = new Date("2026-03-10T15:30:00Z");

describe("parseRange", () => {
  it("defaults to the last 30 days including today (to is exclusive internally)", () => {
    const r = parseRange({}, now);
    expect(r.from.toISOString()).toBe("2026-02-09T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-11T00:00:00.000Z");
    expect(daysBetween(r.from, r.to)).toHaveLength(30);
  });
  it("treats from and to as inclusive UTC dates", () => {
    const r = parseRange({ from: "2026-03-01", to: "2026-03-10" }, now);
    expect(r.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-11T00:00:00.000Z");
    expect(daysBetween(r.from, r.to)).toHaveLength(10);
  });
  it("a single day works", () => expect(daysBetween(...Object.values(parseRange({ from: "2026-03-05", to: "2026-03-05" }, now)) as [Date, Date])).toEqual(["2026-03-05"]));
  it("rejects malformed, impossible and reversed dates", () => {
    for (const bad of [{ from: "03/01/2026" }, { from: "2026-3-1" }, { to: "tomorrow" }, { from: "2026-02-30" }, { to: "2026-13-01" }, { from: "2026-03-10", to: "2026-03-01" }]) {
      expect(() => parseRange(bad, now), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
  it("refuses ranges longer than a year", () => {
    expect(() => parseRange({ from: "2025-01-01", to: "2026-03-10" }, now)).toThrow(/at most 366/);
    expect(() => parseRange({ from: "2025-03-10", to: "2026-03-10" }, now)).not.toThrow();
  });
  it("spans month and year boundaries", () => {
    const r = parseRange({ from: "2025-12-30", to: "2026-01-02" }, now);
    expect(daysBetween(r.from, r.to)).toEqual(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
  });
});
