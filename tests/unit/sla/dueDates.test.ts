import { describe, expect, it } from "vitest";
import { addBusinessMinutes, ALWAYS_OPEN, type CalendarSpec } from "@/modules/sla/dueDates";

const NY = (over: Partial<CalendarSpec> = {}): CalendarSpec => ({
  timezone: "America/New_York", workDays: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 18 * 60, holidays: [], ...over,
});
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("addBusinessMinutes", () => {
  it("24x7: plain addition", () => {
    expect(iso(addBusinessMinutes(at("2026-03-06T12:00:00Z"), 90, ALWAYS_OPEN))).toBe("2026-03-06T13:30:00.000Z");
  });

  it("adds inside the window without skipping (a 15-minute target stays 15 minutes)", () => {
    // Wed 2026-03-04 10:00 EST = 15:00Z
    expect(iso(addBusinessMinutes(at("2026-03-04T15:00:00Z"), 15, NY()))).toBe("2026-03-04T15:15:00.000Z");
  });

  it("rolls over to the next morning after closing time", () => {
    // Wed 17:30 EST + 60 min -> 30 min today, 30 min tomorrow => Thu 09:30 EST = 14:30Z
    expect(iso(addBusinessMinutes(at("2026-03-04T22:30:00Z"), 60, NY()))).toBe("2026-03-05T14:30:00.000Z");
  });

  it("skips the weekend", () => {
    // Fri 2026-03-06 17:30 EST + 60 min -> Mon 03-09 09:30 EST. (DST starts Mar 8, so Monday is EDT = UTC-4 -> 13:30Z)
    expect(iso(addBusinessMinutes(at("2026-03-06T22:30:00Z"), 60, NY()))).toBe("2026-03-09T13:30:00.000Z");
  });

  it("starting outside the window waits for opening time", () => {
    // Sat 12:00 + 30 min -> Mon 09:30 (EDT)
    expect(iso(addBusinessMinutes(at("2026-03-07T17:00:00Z"), 30, NY()))).toBe("2026-03-09T13:30:00.000Z");
    // Wed 07:00 EST + 30 min -> Wed 09:30 EST = 14:30Z
    expect(iso(addBusinessMinutes(at("2026-03-04T12:00:00Z"), 30, NY()))).toBe("2026-03-04T14:30:00.000Z");
  });

  it("skips a holiday", () => {
    // Thu 2026-03-05 is a holiday. Wed 17:30 EST + 60 -> 30 today, then Fri 09:30 EST = 14:30Z
    expect(iso(addBusinessMinutes(at("2026-03-04T22:30:00Z"), 60, NY({ holidays: ["2026-03-05"] })))).toBe("2026-03-06T14:30:00.000Z");
  });

  it("honours minute-resolution windows (09:30-17:45)", () => {
    const cal = NY({ startMinute: 9 * 60 + 30, endMinute: 17 * 60 + 45 });
    // Wed 17:40 EST + 10 min -> 5 min today, 5 min after 09:30 next day = Thu 09:35 EST = 14:35Z
    expect(iso(addBusinessMinutes(at("2026-03-04T22:40:00Z"), 10, cal))).toBe("2026-03-05T14:35:00.000Z");
    // Wed 09:00 EST + 5 min -> opens 09:30 -> 09:35
    expect(iso(addBusinessMinutes(at("2026-03-04T14:00:00Z"), 5, cal))).toBe("2026-03-04T14:35:00.000Z");
  });

  it("a deadline landing exactly on closing time stays on the same day", () => {
    // Wed 17:00 EST + 60 min -> exactly 18:00 EST
    expect(iso(addBusinessMinutes(at("2026-03-04T22:00:00Z"), 60, NY()))).toBe("2026-03-04T23:00:00.000Z");
  });

  it("zero minutes returns the start instant, even outside the window", () => {
    const sat = at("2026-03-07T17:00:00Z");
    expect(iso(addBusinessMinutes(sat, 0, NY()))).toBe(iso(sat));
  });

  it("preserves sub-minute precision", () => {
    expect(iso(addBusinessMinutes(at("2026-03-04T15:00:30Z"), 15, NY()))).toBe("2026-03-04T15:15:30.000Z");
  });

  it("handles the spring-forward DST change (US 2026-03-08)", () => {
    // Fri 2026-03-06 15:00 EST + 8h*60 = 480 min: 3h left Fri (to 18:00) -> Mon 09:00 EDT + 5h = 14:00 EDT = 18:00Z
    expect(iso(addBusinessMinutes(at("2026-03-06T20:00:00Z"), 480, NY()))).toBe("2026-03-09T18:00:00.000Z");
  });

  it("handles the fall-back DST change (US 2026-11-01)", () => {
    // Fri 2026-10-30 17:00 EDT (21:00Z) + 120 min -> 60 Fri, then Mon 11-02 09:00 EST + 60 = 10:00 EST = 15:00Z
    expect(iso(addBusinessMinutes(at("2026-10-30T21:00:00Z"), 120, NY()))).toBe("2026-11-02T15:00:00.000Z");
  });

  it("works in a zone ahead of UTC, where local and UTC dates differ", () => {
    const tokyo: CalendarSpec = { timezone: "Asia/Tokyo", workDays: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 18 * 60, holidays: [] };
    // Fri 2026-03-06 17:30 JST (08:30Z) + 60 -> Mon 09:30 JST = 00:30Z
    expect(iso(addBusinessMinutes(at("2026-03-06T08:30:00Z"), 60, tokyo))).toBe("2026-03-09T00:30:00.000Z");
  });

  it("spans many days (3 business days = 1620 min on a 9h window)", () => {
    // Mon 2026-03-02 09:00 EST (14:00Z) + 1620 = 3 full days -> Wed 18:00 EST = 23:00Z
    expect(iso(addBusinessMinutes(at("2026-03-02T14:00:00Z"), 1620, NY()))).toBe("2026-03-04T23:00:00.000Z");
  });

  it("rejects bad input and a calendar that never opens, instead of looping", () => {
    expect(() => addBusinessMinutes(new Date(), -1, NY())).toThrow(RangeError);
    expect(() => addBusinessMinutes(new Date(), Number.NaN, NY())).toThrow(RangeError);
    expect(() => addBusinessMinutes(at("2026-03-04T15:00:00Z"), 10, NY({ workDays: [] }))).toThrow(/never reaches/);
  });
});
