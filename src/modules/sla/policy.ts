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
