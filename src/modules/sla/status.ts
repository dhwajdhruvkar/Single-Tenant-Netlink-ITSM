// Derived SLA health. Computed from timestamps on read, so correctness never depends on a background job having run.

export const AT_RISK_FRACTION = 0.8;
export type SlaLevel = "none" | "paused" | "met" | "on_track" | "at_risk" | "breached";

export interface SlaFacts {
  status: string;
  createdAt: Date;
  responseDueAt: Date | null;
  resolveDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  slaPausedAt: Date | null;
}

export interface SlaStatus {
  level: SlaLevel;
  responseBreached: boolean;
  resolveBreached: boolean;
  /** Minutes until the next relevant deadline (negative when overdue); null when none or finished. */
  minutesToDeadline: number | null;
}

const DONE = ["resolved", "closed", "cancelled"];

export function slaStatus(t: SlaFacts, now: Date): SlaStatus {
  if (!t.responseDueAt && !t.resolveDueAt) return { level: "none", responseBreached: false, resolveBreached: false, minutesToDeadline: null };

  const paused = t.slaPausedAt !== null;
  // While paused the clock is frozen at the moment the pause began.
  const ref = (paused ? t.slaPausedAt! : now).getTime();
  const done = DONE.includes(t.status);
  const responded = t.firstRespondedAt !== null;

  const responseBreached = t.responseDueAt ? (responded ? t.firstRespondedAt!.getTime() > t.responseDueAt.getTime() : ref > t.responseDueAt.getTime()) : false;
  const resolveBreached = t.resolveDueAt ? (done ? (t.resolvedAt ?? now).getTime() > t.resolveDueAt.getTime() : ref > t.resolveDueAt.getTime()) : false;

  if (done) return { level: responseBreached || resolveBreached ? "breached" : "met", responseBreached, resolveBreached, minutesToDeadline: null };
  if (responseBreached || resolveBreached) return { level: "breached", responseBreached, resolveBreached, minutesToDeadline: null };

  const nextDue = !responded && t.responseDueAt ? t.responseDueAt : t.resolveDueAt;
  if (!nextDue) return { level: paused ? "paused" : "on_track", responseBreached, resolveBreached, minutesToDeadline: null };

  const minutes = (nextDue.getTime() - ref) / 60_000;
  const total = nextDue.getTime() - t.createdAt.getTime();
  const elapsed = total > 0 ? (ref - t.createdAt.getTime()) / total : 0;
  const level: SlaLevel = paused ? "paused" : elapsed >= AT_RISK_FRACTION ? "at_risk" : "on_track";
  return { level, responseBreached, resolveBreached, minutesToDeadline: minutes };
}
