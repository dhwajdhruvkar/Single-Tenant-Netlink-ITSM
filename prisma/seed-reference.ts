// Reference data only: NO employees, NO user accounts, NO demo data. Idempotent: existing rows (which an admin may have
// edited) are never overwritten. Values marked [OPEN] are placeholders until the company confirms them.
import { PrismaClient } from "@prisma/client";

type Seeder = Pick<PrismaClient, "companySetting" | "businessCalendar" | "assignmentGroup" | "category" | "slaPolicy">;

export const SERVICE_DESK_GROUP = "Service Desk";
export const CALENDAR_24X7 = "24x7";

// [OPEN] SLA targets per priority, business hours and holidays are not confirmed. Placeholder 24x7 targets.
const SLA_DEFAULTS = [
  { priority: "p1", responseMinutes: 15, resolveMinutes: 240 },
  { priority: "p2", responseMinutes: 60, resolveMinutes: 480 },
  { priority: "p3", responseMinutes: 240, resolveMinutes: 1440 },
  { priority: "p4", responseMinutes: 480, resolveMinutes: 4320 },
] as const;

// [OPEN] auto-close and reopen windows.
const SETTINGS: Record<string, unknown> = {
  "ticket.autoCloseDays": 5,
  "ticket.reopenWindowDays": 7,
};

export async function seedReference(db: Seeder): Promise<void> {
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.companySetting.upsert({ where: { key }, create: { key, value: value as never }, update: {} });
  }

  const calendar = await db.businessCalendar.upsert({
    where: { name: CALENDAR_24X7 },
    create: { name: CALENDAR_24X7, timezone: "UTC", workDays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 },
    update: {},
  });

  const serviceDesk = await db.assignmentGroup.upsert({
    where: { name: SERVICE_DESK_GROUP },
    create: { name: SERVICE_DESK_GROUP, description: "Triage group: sees tickets that have no group yet.", isTriage: true },
    update: {},
  });

  // [OPEN] category tree. One placeholder so tickets can be filed before IT supplies the real list.
  const hasGeneral = await db.category.findFirst({ where: { name: "General", parentId: null } });
  if (!hasGeneral) {
    await db.category.create({
      data: { name: "General", ticketTypes: ["incident", "service_request"], defaultGroupId: serviceDesk.id, sortOrder: 0 },
    });
  }

  for (const p of SLA_DEFAULTS) {
    const name = `${p.priority.toUpperCase()} default (placeholder)`;
    await db.slaPolicy.upsert({
      where: { name },
      create: { name, priority: p.priority, responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes, calendarId: calendar.id },
      update: {},
    });
  }
}

async function main() {
  const { assertSafeDatabase } = await import("../src/platform/db/guards");
  const { KNOWN_MIGRATIONS } = await import("../src/platform/db/knownMigrations");
  const prisma = new PrismaClient();
  try {
    await assertSafeDatabase(prisma, KNOWN_MIGRATIONS);
    await seedReference(prisma);
    console.log("reference data seeded");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /seed-reference\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
