// Business-calendar arithmetic for SLA due dates. Pure functions (no I/O), timezone- and DST-aware.
// Weekdays are ISO (1 = Monday .. 7 = Sunday). The working window is [startMinute, endMinute) in minutes after local midnight.
// Adapted from the reference implementation's calendar walker, which was hour-granular and Sunday=0.

export interface CalendarSpec {
  timezone: string;
  workDays: readonly number[];
  startMinute: number;
  endMinute: number;
  /** Holidays as YYYY-MM-DD in the calendar's timezone. */
  holidays: readonly string[];
}

export const ALWAYS_OPEN: CalendarSpec = { timezone: "UTC", workDays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440, holidays: [] };

const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MINUTE_MS = 60_000;

interface Zoned {
  weekday: number;
  minuteOfDay: number;
  ymd: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(date: Date, timezone: string): Zoned {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timezone, fmt);
  }
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { weekday: ISO_WEEKDAY[p.weekday] ?? 1, minuteOfDay: Number(p.hour) * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
}

export function isAlwaysOpen(c: CalendarSpec): boolean {
  return c.startMinute === 0 && c.endMinute === 1440 && c.holidays.length === 0 && [1, 2, 3, 4, 5, 6, 7].every((d) => c.workDays.includes(d));
}

const MAX_STEPS = 24 * 366 * 3;

/**
 * The instant at which `minutes` of working time have elapsed after `from`. The wall clock is re-evaluated in the calendar's
 * timezone at every step, so DST changes and holidays are honoured. Throws if the calendar never opens (guards against a loop).
 */
export function addBusinessMinutes(from: Date, minutes: number, calendar: CalendarSpec): Date {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError("minutes must be a non-negative number");
  if (isAlwaysOpen(calendar)) return new Date(from.getTime() + minutes * MINUTE_MS);

  const holidays = new Set(calendar.holidays);
  let cursor = from.getTime();
  let remainingMs = minutes * MINUTE_MS;

  for (let steps = 0; remainingMs > 0; steps++) {
    if (steps > MAX_STEPS) throw new Error("Business calendar never reaches the requested working time");
    const z = zoned(new Date(cursor), calendar.timezone);
    const msIntoMinute = ((cursor % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
    const open = calendar.workDays.includes(z.weekday) && !holidays.has(z.ymd);

    if (open && z.minuteOfDay >= calendar.startMinute && z.minuteOfDay < calendar.endMinute) {
      const availableMs = (calendar.endMinute - z.minuteOfDay) * MINUTE_MS - msIntoMinute;
      const step = Math.min(remainingMs, availableMs);
      cursor += step;
      remainingMs -= step;
    } else if (open && z.minuteOfDay < calendar.startMinute) {
      cursor += (calendar.startMinute - z.minuteOfDay) * MINUTE_MS - msIntoMinute; // jump to opening time
    } else {
      cursor += (60 - (z.minuteOfDay % 60)) * MINUTE_MS - msIntoMinute; // next hour boundary (DST-safe, re-evaluated)
    }
  }
  return new Date(cursor);
}
