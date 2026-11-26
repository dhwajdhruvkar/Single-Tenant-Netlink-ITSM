import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedReference } from "../../prisma/seed-reference";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

async function counts() {
  return {
    settings: await prisma.companySetting.count(),
    calendars: await prisma.businessCalendar.count(),
    groups: await prisma.assignmentGroup.count(),
    categories: await prisma.category.count(),
    sla: await prisma.slaPolicy.count(),
  };
}

describe("reference seed", () => {
  it("creates reference data and no people", async () => {
    await seedReference(prisma);
    expect(await counts()).toEqual({ settings: 2, calendars: 1, groups: 1, categories: 1, sla: 4 });
    expect(await prisma.employee.count()).toBe(0);
    expect(await prisma.userAccount.count()).toBe(0);
    const triage = await prisma.assignmentGroup.findUniqueOrThrow({ where: { name: "Service Desk" } });
    expect(triage.isTriage).toBe(true);
  });

  it("is idempotent: a second run leaves the same rows", async () => {
    await seedReference(prisma);
    const first = await counts();
    await seedReference(prisma);
    expect(await counts()).toEqual(first);
  });

  it("does not overwrite values an admin has edited", async () => {
    await seedReference(prisma);
    await prisma.companySetting.update({ where: { key: "ticket.autoCloseDays" }, data: { value: 9 } });
    await seedReference(prisma);
    expect((await prisma.companySetting.findUniqueOrThrow({ where: { key: "ticket.autoCloseDays" } })).value).toBe(9);
  });
});
