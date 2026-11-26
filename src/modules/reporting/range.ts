import { ValidationError } from "@/platform/errors";
import { MAX_RANGE_DAYS } from "./queries";

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: string, name: string): Date {
  if (!DATE.test(value)) throw new ValidationError(`${name} must be a date like 2026-03-31.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new ValidationError(`${name} is not a valid date.`);
  return d;
}

/**
 * `from` and `to` are inclusive UTC dates. Default: the last 30 days including today. Returns [from, to) as instants (to = the day after `to`).
 * Ranges longer than a year are refused so a report cannot be asked to scan unbounded history.
 */
export function parseRange(params: { from?: string | null; to?: string | null }, now: Date = new Date()): { from: Date; to: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toDay = params.to ? parseDay(params.to, "to") : today;
  const fromDay = params.from ? parseDay(params.from, "from") : new Date(toDay.getTime() - 29 * DAY);
  if (fromDay.getTime() > toDay.getTime()) throw new ValidationError("from must not be after to.");
  const to = new Date(toDay.getTime() + DAY);
  if ((to.getTime() - fromDay.getTime()) / DAY > MAX_RANGE_DAYS) throw new ValidationError(`The range can be at most ${MAX_RANGE_DAYS} days.`);
  return { from: fromDay, to };
}
