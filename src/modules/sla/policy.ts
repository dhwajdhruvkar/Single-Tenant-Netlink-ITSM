import type { PrismaClient } from "@prisma/client";
import { addBusinessMinutes, ALWAYS_OPEN, type CalendarSpec } from "./dueDates";

export interface SlaDues {
  slaPolicyId: string | null;
  responseDueAt: Date | null;
  resolveDueAt: Date | null;
}

type Db = Pick<PrismaClient, "slaPolicy">;

const NO_SLA: SlaDues = { slaPolicyId: null, responseDueAt: null, resolveDueAt: null };

/**
 * Pick the active policy for (priority, type): a type-specific policy wins over an "all types" one. With no policy there are
 * no due dates -- SLA targets are [OPEN] company decisions and are never invented here.
 */
export async function computeSlaDues(db: Db, input: { priority: "p1" | "p2" | "p3" | "p4"; type: "incident" | "service_request"; createdAt: Date }): Promise<SlaDues> {
  const candidates = await db.slaPolicy.findMany({
    where: { active: true, priority: input.priority, OR: [{ ticketType: input.type }, { ticketType: null }] },
    include: { calendar: { include: { holidays: true } } },
  });
  const policy = candidates.find((p) => p.ticketType === input.type) ?? candidates.find((p) => p.ticketType === null);
  if (!policy) return NO_SLA;

  const calendar: CalendarSpec = policy.calendar
    ? {
        timezone: policy.calendar.timezone,
        workDays: policy.calendar.workDays,
        startMinute: policy.calendar.startMinute,
        endMinute: policy.calendar.endMinute,
        holidays: policy.calendar.holidays.map((h) => h.date.toISOString().slice(0, 10)),
      }
    : ALWAYS_OPEN; // calendarId null = 24x7

  return {
    slaPolicyId: policy.id,
    responseDueAt: addBusinessMinutes(input.createdAt, policy.responseMinutes, calendar),
    resolveDueAt: addBusinessMinutes(input.createdAt, policy.resolveMinutes, calendar),
  };
}

/** The calendar a ticket's SLA runs on: its policy's calendar, or 24x7 when there is no policy or no calendar. */
export async function calendarForPolicy(db: Pick<PrismaClient, "slaPolicy">, slaPolicyId: string | null): Promise<CalendarSpec> {
  if (!slaPolicyId) return ALWAYS_OPEN;
  const p = await db.slaPolicy.findUnique({ where: { id: slaPolicyId }, include: { calendar: { include: { holidays: true } } } });
  if (!p?.calendar) return ALWAYS_OPEN;
  return {
    timezone: p.calendar.timezone,
    workDays: p.calendar.workDays,
    startMinute: p.calendar.startMinute,
    endMinute: p.calendar.endMinute,
    holidays: p.calendar.holidays.map((h) => h.date.toISOString().slice(0, 10)),
  };
}

/**
 * Due dates for a ticket whose priority (or type) changed: recomputed from its creation time, then pushed out by the business minutes it
 * has already spent on hold, so time on hold is not clawed back by the recalculation.
 */
export async function recomputeSlaDues(
  db: Pick<PrismaClient, "slaPolicy">,
  input: { priority: "p1" | "p2" | "p3" | "p4"; type: "incident" | "service_request"; createdAt: Date; slaPausedMinutes: number },
): Promise<SlaDues> {
  const base = await computeSlaDues(db, input);
  if (!base.slaPolicyId || input.slaPausedMinutes <= 0) return base;
  const calendar = await calendarForPolicy(db, base.slaPolicyId);
  return {
    slaPolicyId: base.slaPolicyId,
    responseDueAt: base.responseDueAt && addBusinessMinutes(base.responseDueAt, input.slaPausedMinutes, calendar),
    resolveDueAt: base.resolveDueAt && addBusinessMinutes(base.resolveDueAt, input.slaPausedMinutes, calendar),
  };
}
