import { describe, expect, it } from "vitest";
import { addBusinessMinutes, ALWAYS_OPEN, calendarMinutesBetween, type CalendarSpec } from "@/modules/sla/dueDates";
import { pausePatch, type PauseFacts } from "@/modules/sla/pause";

const NY: CalendarSpec = { timezone: "America/New_York", workDays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080, holidays: [] };
const at = (s: string) => new Date(s);
const iso = (d: Date | null | undefined) => d?.toISOString();

describe("calendarMinutesBetween", () => {
  it("24x7: wall-clock minutes", () => expect(calendarMinutesBetween(at("2026-03-04T10:00:00Z"), at("2026-03-04T12:30:00Z"), ALWAYS_OPEN)).toBe(150));
  it("counts only open hours within a day", () => {
    // Wed 08:00-19:00 EST -> 9 working hours
    expect(calendarMinutesBetween(at("2026-03-04T13:00:00Z"), at("2026-03-05T00:00:00Z"), NY)).toBe(540);
  });
  it("a weekend contributes nothing", () => {
    // Fri 17:00 EST -> Mon 09:00 EDT: 1 working hour on Friday only
    expect(calendarMinutesBetween(at("2026-03-06T22:00:00Z"), at("2026-03-09T13:00:00Z"), NY)).toBe(60);
  });
  it("holidays contribute nothing", () => {
    expect(calendarMinutesBetween(at("2026-03-04T14:00:00Z"), at("2026-03-05T23:00:00Z"), { ...NY, holidays: ["2026-03-05"] })).toBe(540);
  });
  it("zero or negative ranges are 0, and it is the inverse of addBusinessMinutes", () => {
    expect(calendarMinutesBetween(at("2026-03-04T15:00:00Z"), at("2026-03-04T15:00:00Z"), NY)).toBe(0);
    expect(calendarMinutesBetween(at("2026-03-04T16:00:00Z"), at("2026-03-04T15:00:00Z"), NY)).toBe(0);
    const from = at("2026-03-06T20:00:00Z");
    for (const m of [30, 200, 540, 1300]) expect(calendarMinutesBetween(from, addBusinessMinutes(from, m, NY), NY)).toBeCloseTo(m, 6);
  });
});

const base: PauseFacts = { status: "in_progress", slaPausedAt: null, slaPausedMinutes: 0, responseDueAt: at("2026-03-04T16:00:00Z"), resolveDueAt: at("2026-03-04T20:00:00Z"), firstRespondedAt: null };

describe("pausePatch", () => {
  const now = at("2026-03-04T15:00:00Z");

  it("entering a pausing hold stamps the pause and changes nothing else", () => {
    expect(pausePatch(base, { status: "on_hold", holdReason: "awaiting_requester" }, now, ALWAYS_OPEN)).toEqual({ slaPausedAt: now });
  });
  it("a non-pausing hold reason does not stop the clock ([OPEN] default)", () => {
    expect(pausePatch(base, { status: "on_hold", holdReason: "awaiting_vendor" }, now, ALWAYS_OPEN)).toEqual({});
    expect(pausePatch(base, { status: "on_hold", holdReason: "awaiting_vendor" }, now, ALWAYS_OPEN, ["awaiting_vendor"])).toEqual({ slaPausedAt: now });
  });
  it("leaving the hold credits the minutes and pushes both due dates by that much (24x7)", () => {
    const paused = { ...base, status: "on_hold", slaPausedAt: at("2026-03-04T14:30:00Z") };
    const p = pausePatch(paused, { status: "in_progress", holdReason: null }, now, ALWAYS_OPEN);
    expect(p.slaPausedAt).toBeNull();
    expect(p.slaPausedMinutes).toBe(30);
    expect(iso(p.responseDueAt)).toBe("2026-03-04T16:30:00.000Z");
    expect(iso(p.resolveDueAt)).toBe("2026-03-04T20:30:00.000Z");
  });
  it("accumulates across several holds", () => {
    const paused = { ...base, status: "on_hold", slaPausedMinutes: 45, slaPausedAt: at("2026-03-04T14:50:00Z") };
    expect(pausePatch(paused, { status: "resolved", holdReason: null }, now, ALWAYS_OPEN).slaPausedMinutes).toBe(55);
  });
  it("does not move the response due date once the first response happened", () => {
    const paused = { ...base, status: "on_hold", slaPausedAt: at("2026-03-04T14:30:00Z"), firstRespondedAt: at("2026-03-04T14:00:00Z") };
    const p = pausePatch(paused, { status: "in_progress", holdReason: null }, now, ALWAYS_OPEN);
    expect(p.responseDueAt).toBeUndefined();
    expect(p.resolveDueAt).toBeDefined();
  });
  it("business calendar: a weekend on hold credits only the working minutes, so the due date moves by business time", () => {
    // paused Fri 17:00 EST, resumed Mon 09:30 EDT -> 60 + 30 = 90 business minutes
    const paused: PauseFacts = { ...base, status: "on_hold", slaPausedAt: at("2026-03-06T22:00:00Z"), responseDueAt: null, resolveDueAt: at("2026-03-10T14:00:00Z") };
    const p = pausePatch(paused, { status: "in_progress", holdReason: null }, at("2026-03-09T13:30:00Z"), NY);
    expect(p.slaPausedMinutes).toBe(90);
    // due Tue 10:00 EDT + 90 business min = Tue 11:30 EDT = 15:30Z (NOT +64h of wall clock)
    expect(iso(p.resolveDueAt)).toBe("2026-03-10T15:30:00.000Z");
  });
  it("does nothing for transitions that neither enter nor leave a pause", () => {
    expect(pausePatch(base, { status: "resolved", holdReason: null }, now, ALWAYS_OPEN)).toEqual({});
    expect(pausePatch({ ...base, status: "on_hold", slaPausedAt: now }, { status: "on_hold", holdReason: "awaiting_requester" }, now, ALWAYS_OPEN)).toEqual({});
  });
});
