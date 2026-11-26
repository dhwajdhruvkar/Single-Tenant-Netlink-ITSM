import { z } from "zod";
import type { Actor } from "@/modules/identity/actor";
import { NotFoundError, UnprocessableError, ValidationError } from "@/platform/errors";
import { adminWrite, assertAdmin, diff, type AdminDeps } from "./shared";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const CalendarCreate = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "Unknown time zone (use an IANA name such as America/New_York)."),
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).strict().refine((c) => c.startMinute < c.endMinute, { message: "The working day must end after it starts.", path: ["endMinute"] });
export const CalendarUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "Unknown time zone (use an IANA name such as America/New_York).").optional(),
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((d) => [...new Set(d)].sort()).optional(),
  startMinute: z.number().int().min(0).max(1439).optional(),
  endMinute: z.number().int().min(1).max(1440).optional(),
}).strict();
export const HolidayAdd = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)), "Invalid date"), name: z.string().trim().min(1).max(100) }).strict();

export const PolicyCreate = z.object({
  name: z.string().trim().min(1).max(100),
  priority: z.enum(["p1", "p2", "p3", "p4"]),
  ticketType: z.enum(["incident", "service_request"]).nullable().optional(), // null = all types
  responseMinutes: z.number().int().min(1).max(525_600),
  resolveMinutes: z.number().int().min(1).max(525_600),
  calendarId: z.string().uuid().nullable().optional(), // null = 24x7
}).strict();
export const PolicyUpdate = PolicyCreate.partial().extend({ active: z.boolean().optional() }).strict();

export async function listSla(db: AdminDeps["db"], actor: Actor) {
  assertAdmin(actor);
  const [policies, calendars] = await Promise.all([
    db.slaPolicy.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }] }),
    db.businessCalendar.findMany({ orderBy: { name: "asc" }, include: { holidays: { orderBy: { date: "asc" } } } }),
  ]);
  return {
    policies,
    calendars: calendars.map((c) => ({ id: c.id, name: c.name, timezone: c.timezone, workDays: c.workDays, startMinute: c.startMinute, endMinute: c.endMinute, holidays: c.holidays.map((h) => ({ id: h.id, date: h.date.toISOString().slice(0, 10), name: h.name })) })),
  };
}

const ACTIVE_CLASH = "Another active policy already covers this priority and ticket type. Deactivate it first.";

export async function createPolicy(deps: AdminDeps, actor: Actor, input: z.infer<typeof PolicyCreate>, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "sla_policy.create", entityType: "sla_policy" }, async (tx) => {
    if (input.calendarId && !(await tx.businessCalendar.findUnique({ where: { id: input.calendarId }, select: { id: true } }))) throw new UnprocessableError("CALENDAR_INVALID", "The calendar does not exist.");
    const p = await tx.slaPolicy.create({ data: { ...input, ticketType: input.ticketType ?? null, calendarId: input.calendarId ?? null } });
    return { result: { id: p.id }, entityId: p.id, changes: { name: p.name, priority: p.priority, responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes } };
  }, ACTIVE_CLASH, requestId);
}

export async function updatePolicy(deps: AdminDeps, actor: Actor, id: string, input: z.infer<typeof PolicyUpdate>, requestId?: string) {
  assertAdmin(actor);
  if (Object.keys(input).length === 0) throw new ValidationError("Nothing to change.");
  return adminWrite(deps, actor, { action: "sla_policy.update", entityType: "sla_policy" }, async (tx) => {
    const before = await tx.slaPolicy.findUnique({ where: { id } });
    if (!before) throw new NotFoundError();
    if (input.calendarId && !(await tx.businessCalendar.findUnique({ where: { id: input.calendarId }, select: { id: true } }))) throw new UnprocessableError("CALENDAR_INVALID", "The calendar does not exist.");
    const changes = diff(before as never, input as never);
    if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");
    await tx.slaPolicy.update({ where: { id }, data: input });
    // Existing tickets keep the due dates they were given; a change applies to tickets created (or re-prioritised) from now on.
    return { result: { id }, entityId: id, changes };
  }, ACTIVE_CLASH, requestId);
}

export async function createCalendar(deps: AdminDeps, actor: Actor, input: z.infer<typeof CalendarCreate>, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "calendar.create", entityType: "business_calendar" }, async (tx) => {
    const c = await tx.businessCalendar.create({ data: input });
    return { result: { id: c.id }, entityId: c.id, changes: { name: c.name, timezone: c.timezone } };
  }, "A calendar with that name already exists.", requestId);
}

export async function updateCalendar(deps: AdminDeps, actor: Actor, id: string, input: z.infer<typeof CalendarUpdate>, requestId?: string) {
  assertAdmin(actor);
  if (Object.keys(input).length === 0) throw new ValidationError("Nothing to change.");
  return adminWrite(deps, actor, { action: "calendar.update", entityType: "business_calendar" }, async (tx) => {
    const before = await tx.businessCalendar.findUnique({ where: { id } });
    if (!before) throw new NotFoundError();
    const start = input.startMinute ?? before.startMinute;
    const end = input.endMinute ?? before.endMinute;
    if (start >= end) throw new UnprocessableError("CALENDAR_HOURS", "The working day must end after it starts.");
    const changes = diff(before as never, input as never);
    if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");
    await tx.businessCalendar.update({ where: { id }, data: input });
    return { result: { id }, entityId: id, changes };
  }, "A calendar with that name already exists.", requestId);
}

export async function addHoliday(deps: AdminDeps, actor: Actor, calendarId: string, input: z.infer<typeof HolidayAdd>, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "calendar.holiday_add", entityType: "business_calendar" }, async (tx) => {
    if (!(await tx.businessCalendar.findUnique({ where: { id: calendarId }, select: { id: true } }))) throw new NotFoundError();
    const h = await tx.businessHoliday.create({ data: { calendarId, date: new Date(`${input.date}T00:00:00Z`), name: input.name } });
    return { result: { id: h.id }, entityId: calendarId, changes: { date: input.date, name: input.name } };
  }, "That date is already a holiday in this calendar.", requestId);
}

export async function removeHoliday(deps: AdminDeps, actor: Actor, calendarId: string, holidayId: string, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "calendar.holiday_remove", entityType: "business_calendar" }, async (tx) => {
    const r = await tx.businessHoliday.deleteMany({ where: { id: holidayId, calendarId } });
    if (r.count === 0) throw new NotFoundError();
    return { result: { id: holidayId }, entityId: calendarId, changes: { holidayId } };
  }, "Could not remove the holiday.", requestId);
}

