import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { allocateTicketNumber, formatReference } from "@/modules/tickets/reference";
import { assertSafeDatabase, UnsafeDatabaseError } from "@/platform/db/guards";
import { KNOWN_MIGRATIONS } from "@/platform/db/knownMigrations";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

let seq = 0;
async function employee(overrides: Partial<Prisma.EmployeeUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.employee.create({
    data: {
      entraObjectId: randomUUID(),
      userPrincipalName: `user${seq}@example.test`,
      displayName: `User ${seq}`,
      ...overrides,
    },
  });
}

async function ticketFor(requesterId: string, createdById: string, extra: Partial<Prisma.TicketUncheckedCreateInput> = {}) {
  return prisma.$transaction(async (tx) => {
    const number = await allocateTicketNumber(tx);
    return tx.ticket.create({
      data: {
        number,
        reference: formatReference("incident", number),
        type: "incident",
        channel: "portal",
        subject: "Printer is on fire",
        description: "Please help",
        impact: "medium",
        urgency: "medium",
        priority: "p3",
        requesterEmployeeId: requesterId,
        createdByEmployeeId: createdById,
        requesterName: "Requester",
        ...extra,
      },
    });
  });
}

describe("Employee identity", () => {
  it("enforces a unique entraObjectId", async () => {
    const oid = randomUUID();
    await employee({ entraObjectId: oid });
    await expect(employee({ entraObjectId: oid })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows two employees to share a mail value (email is not the identity key)", async () => {
    await employee({ mail: "shared@example.test" });
    await expect(employee({ mail: "shared@example.test" })).resolves.toBeDefined();
  });

  it("allows an Employee without a UserAccount (requester who never signed in)", async () => {
    const e = await employee();
    expect(await prisma.userAccount.findUnique({ where: { employeeId: e.id } })).toBeNull();
  });

  it("has exactly one UserAccount per employee", async () => {
    const e = await employee();
    await prisma.userAccount.create({ data: { employeeId: e.id } });
    await expect(prisma.userAccount.create({ data: { employeeId: e.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("Ticket constraints", () => {
  it("restricts deleting an employee who is a requester", async () => {
    const e = await employee();
    await ticketFor(e.id, e.id);
    await expect(prisma.employee.delete({ where: { id: e.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("restricts deleting an employee who created a ticket for someone else", async () => {
    const requester = await employee();
    const agent = await employee();
    await ticketFor(requester.id, agent.id);
    await expect(prisma.employee.delete({ where: { id: agent.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("makes (createdByEmployeeId, idempotencyKey) unique, but only per creator", async () => {
    const a = await employee();
    const b = await employee();
    await ticketFor(a.id, a.id, { idempotencyKey: "k1" });
    await expect(ticketFor(a.id, a.id, { idempotencyKey: "k1" })).rejects.toMatchObject({ code: "P2002" });
    await expect(ticketFor(b.id, b.id, { idempotencyKey: "k1" })).resolves.toBeDefined();
  });

  it("allows many tickets without an idempotency key", async () => {
    const a = await employee();
    await ticketFor(a.id, a.id);
    await expect(ticketFor(a.id, a.id)).resolves.toBeDefined();
  });

  it("increments the ticket number under 20 parallel inserts with no duplicate numbers or references", async () => {
    const e = await employee();
    const created = await Promise.all(Array.from({ length: 20 }, () => ticketFor(e.id, e.id)));
    expect(new Set(created.map((t) => t.number)).size).toBe(20);
    expect(new Set(created.map((t) => t.reference)).size).toBe(20);
    for (const t of created) expect(t.reference).toBe(formatReference("incident", t.number));
  });

  it("requires a holdReason exactly when the ticket is on hold", async () => {
    const e = await employee();
    await expect(ticketFor(e.id, e.id, { status: "on_hold" })).rejects.toThrow(/ticket_hold_reason_check/);
    await expect(ticketFor(e.id, e.id, { status: "in_progress", holdReason: "other" })).rejects.toThrow(/ticket_hold_reason_check/);
    await expect(ticketFor(e.id, e.id, { status: "on_hold", holdReason: "awaiting_requester" })).resolves.toBeDefined();
  });

  it("requires a reason for a priority override", async () => {
    const e = await employee();
    await expect(ticketFor(e.id, e.id, { priorityOverridden: true })).rejects.toThrow(/ticket_priority_override_reason_check/);
    await expect(ticketFor(e.id, e.id, { priorityOverridden: true, priorityOverrideReason: "VIP" })).resolves.toBeDefined();
  });

  it("populates the generated full-text column and finds a ticket by subject", async () => {
    const e = await employee();
    const t = await ticketFor(e.id, e.id, { subject: "Quarterly VPN outage" });
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Ticket" WHERE search @@ plainto_tsquery('simple', 'vpn')`;
    expect(rows.map((r) => r.id)).toEqual([t.id]);
  });
});

describe("SLA constraints", () => {
  it("allows only one active policy per priority and type, and one all-types policy per priority", async () => {
    await prisma.slaPolicy.create({ data: { name: "a", priority: "p1", responseMinutes: 10, resolveMinutes: 60 } });
    await expect(
      prisma.slaPolicy.create({ data: { name: "b", priority: "p1", responseMinutes: 10, resolveMinutes: 60 } }),
    ).rejects.toMatchObject({ code: "P2002", meta: { target: ["priority"] } });
    await expect(
      prisma.slaPolicy.create({ data: { name: "c", priority: "p1", ticketType: "incident", responseMinutes: 5, resolveMinutes: 30 } }),
    ).resolves.toBeDefined();
    await expect(
      prisma.slaPolicy.create({ data: { name: "d", priority: "p1", ticketType: "incident", responseMinutes: 5, resolveMinutes: 30 } }),
    ).rejects.toMatchObject({ code: "P2002", meta: { target: ["priority", "ticketType"] } });
    await expect(
      prisma.slaPolicy.create({ data: { name: "e", priority: "p1", ticketType: "incident", active: false, responseMinutes: 5, resolveMinutes: 30 } }),
    ).resolves.toBeDefined();
  });

  it("rejects non-positive minutes and invalid calendars", async () => {
    await expect(
      prisma.slaPolicy.create({ data: { name: "z", priority: "p2", responseMinutes: 0, resolveMinutes: 60 } }),
    ).rejects.toThrow(/sla_policy_minutes_check/);
    await expect(
      prisma.businessCalendar.create({ data: { name: "bad", timezone: "UTC", workDays: [1, 8], startMinute: 0, endMinute: 100 } }),
    ).rejects.toThrow(/business_calendar_workdays_check/);
    await expect(
      prisma.businessCalendar.create({ data: { name: "bad2", timezone: "UTC", workDays: [1], startMinute: 600, endMinute: 600 } }),
    ).rejects.toThrow(/business_calendar_hours_check/);
  });
});

describe("Startup guard against a foreign database", () => {
  it("accepts the migrated test database", async () => {
    await expect(assertSafeDatabase(prisma, KNOWN_MIGRATIONS)).resolves.toBeUndefined();
  });

  it('refuses a database that has a "Tenant" table', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "Tenant" (id text PRIMARY KEY)`);
    try {
      await expect(assertSafeDatabase(prisma, KNOWN_MIGRATIONS)).rejects.toBeInstanceOf(UnsafeDatabaseError);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE "Tenant"`);
    }
  });

  it("refuses a database whose migration history has names from another repository", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('guard-test', 'x', '20261113090000_performance_indexes', now(), 1)`,
    );
    try {
      await expect(assertSafeDatabase(prisma, KNOWN_MIGRATIONS)).rejects.toThrow(/20261113090000_performance_indexes/);
    } finally {
      await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE id = 'guard-test'`);
    }
  });
});
