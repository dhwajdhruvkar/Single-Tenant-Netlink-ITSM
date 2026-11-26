import { addBusinessMinutes, calendarMinutesBetween, type CalendarSpec } from "./dueDates";

// SLA pause bookkeeping for status changes. Entering a pausing hold stamps `slaPausedAt`; leaving it credits the BUSINESS minutes that
// passed (per the policy's calendar) and pushes the due dates out by that many business minutes, so the clock genuinely stopped.
// (The reference implementation shifted by wall-clock time, which over-credits weekends for business-hours calendars.)

export interface PauseFacts {
  status: string;
  slaPausedAt: Date | null;
  slaPausedMinutes: number;
  responseDueAt: Date | null;
  resolveDueAt: Date | null;
  firstRespondedAt: Date | null;
}

export interface PauseNext {
  status: string;
  holdReason: string | null;
}

export interface PausePatch {
  slaPausedAt?: Date | null;
  slaPausedMinutes?: number;
  responseDueAt?: Date | null;
  resolveDueAt?: Date | null;
}

/** [OPEN] Which hold reasons stop the clock. Default: only `awaiting_requester`. */
export const DEFAULT_PAUSING_REASONS: readonly string[] = ["awaiting_requester"];

export function pausePatch(t: PauseFacts, next: PauseNext, now: Date, calendar: CalendarSpec, pausingReasons: readonly string[] = DEFAULT_PAUSING_REASONS): PausePatch {
  const entering = next.status === "on_hold" && next.holdReason !== null && pausingReasons.includes(next.holdReason) && t.slaPausedAt === null;
  if (entering) return { slaPausedAt: now };

  const leaving = t.slaPausedAt !== null && next.status !== "on_hold";
  if (!leaving) return {};

  const paused = Math.round(calendarMinutesBetween(t.slaPausedAt!, now, calendar));
  const patch: PausePatch = { slaPausedAt: null, slaPausedMinutes: t.slaPausedMinutes + paused };
  if (paused > 0) {
    if (t.resolveDueAt) patch.resolveDueAt = addBusinessMinutes(t.resolveDueAt, paused, calendar);
    if (t.responseDueAt && !t.firstRespondedAt) patch.responseDueAt = addBusinessMinutes(t.responseDueAt, paused, calendar);
  }
  return patch;
}
