import { describe, expect, it } from "vitest";
import { AT_RISK_FRACTION, slaStatus, type SlaFacts } from "@/modules/sla/status";

const MIN = 60_000;
const now = new Date("2026-03-04T12:00:00Z");
const m = (min: number) => new Date(now.getTime() + min * MIN);
const t = (o: Partial<SlaFacts> = {}): SlaFacts => ({ status: "in_progress", createdAt: m(-60), responseDueAt: null, resolveDueAt: null, firstRespondedAt: null, resolvedAt: null, slaPausedAt: null, ...o });

describe("slaStatus", () => {
  it("is 'none' without due dates", () => expect(slaStatus(t(), now).level).toBe("none"));
  it("breached when the response deadline passed unanswered", () => {
    const s = slaStatus(t({ responseDueAt: m(-1), resolveDueAt: m(300) }), now);
    expect(s).toMatchObject({ level: "breached", responseBreached: true, resolveBreached: false });
  });
  it("a late response is still recorded as breached once answered, an on-time one is not", () => {
    expect(slaStatus(t({ responseDueAt: m(-10), firstRespondedAt: m(-5), resolveDueAt: m(300) }), now).responseBreached).toBe(true);
    expect(slaStatus(t({ responseDueAt: m(-10), firstRespondedAt: m(-20), resolveDueAt: m(300) }), now).responseBreached).toBe(false);
  });
  it("on track when comfortably early", () => expect(slaStatus(t({ createdAt: m(-10), resolveDueAt: m(600), firstRespondedAt: m(-5) }), now).level).toBe("on_track"));
  it("at risk from 75% of the window elapsed (roadmap)", () => {
    expect(AT_RISK_FRACTION).toBe(0.75);
    // window 100 min; 74 elapsed vs 76 elapsed
    expect(slaStatus(t({ createdAt: m(-74), resolveDueAt: m(26), firstRespondedAt: m(-70) }), now).level).toBe("on_track");
    expect(slaStatus(t({ createdAt: m(-76), resolveDueAt: m(24), firstRespondedAt: m(-70) }), now).level).toBe("at_risk");
  });
  it("targets the response deadline until the first response, then the resolution deadline", () => {
    const before = slaStatus(t({ createdAt: m(-10), responseDueAt: m(20), resolveDueAt: m(600) }), now);
    expect(before.minutesToDeadline).toBe(20);
    const after = slaStatus(t({ createdAt: m(-10), responseDueAt: m(20), resolveDueAt: m(600), firstRespondedAt: m(-5) }), now);
    expect(after.minutesToDeadline).toBe(600);
  });
  it("met once resolved in time, breached if resolved late", () => {
    expect(slaStatus(t({ status: "resolved", resolvedAt: m(-5), resolveDueAt: m(30), firstRespondedAt: m(-40) }), now).level).toBe("met");
    expect(slaStatus(t({ status: "resolved", resolvedAt: m(-5), resolveDueAt: m(-30), firstRespondedAt: m(-90) }), now).level).toBe("breached");
  });
  it("the clock is frozen at the pause time: no breach while waiting", () => {
    const s = slaStatus(t({ status: "on_hold", slaPausedAt: m(-120), resolveDueAt: m(-100), createdAt: m(-300), firstRespondedAt: m(-290) }), now);
    expect(s.resolveBreached).toBe(false); // paused 120 min ago, due 100 min ago => it was NOT yet overdue when the clock stopped
    expect(s.level).toBe("paused");
  });
  it("a deadline already missed at the moment of pausing stays breached", () => {
    expect(slaStatus(t({ status: "on_hold", slaPausedAt: m(-10), resolveDueAt: m(-100), createdAt: m(-300), firstRespondedAt: m(-290) }), now).level).toBe("breached");
  });
  it("is a pure function of its inputs: a missed background run changes nothing", () => {
    const facts = t({ resolveDueAt: m(-5), createdAt: m(-100), firstRespondedAt: m(-90) });
    expect(slaStatus(facts, now)).toEqual(slaStatus(facts, now));
    expect(slaStatus(facts, now).level).toBe("breached"); // derived from timestamps; no `resolveBreachedAt` marker needed
  });
});
