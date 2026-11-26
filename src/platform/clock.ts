// Injectable clock so time-dependent logic (SLA, sessions, jobs) is testable.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const value = new Date(at);
  return { now: () => new Date(value) };
}
