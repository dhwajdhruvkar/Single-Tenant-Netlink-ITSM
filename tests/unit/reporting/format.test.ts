import { describe, expect, it } from "vitest";
import { formatMinutes, formatPct } from "@/ui/reports/format";

describe("formatMinutes", () => {
  it.each([[null, "–"], [0, "< 1 m"], [0.4, "< 1 m"], [45, "45 m"], [60, "1 h"], [95, "1 h 35 m"], [1440, "1 d"], [1500, "1 d 1 h"], [2880, "2 d"]])("%s -> %s", (m, out) => {
    expect(formatMinutes(m as number | null)).toBe(out);
  });
});
describe("formatPct", () => { it("handles null and values", () => { expect(formatPct(null)).toBe("–"); expect(formatPct(66.7)).toBe("66.7%"); expect(formatPct(0)).toBe("0%"); }); });
