import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakeDirectoryProvider } from "@/modules/directory/fakeDirectoryProvider";
import { getOwnProfile, PROFILE_REFRESH_AFTER_MS } from "@/modules/directory/profileService";
import { searchEmployees, searchLocal } from "@/modules/directory/searchService";
import { DELTA_SCHEDULE, runDeltaSync, runFullSync } from "@/modules/directory/syncService";
import { dirUser } from "../support/directoryUsers";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
const eligibility = { excludeUpnPrefixes: ["svc-"] };

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

const byOid = (oid: string) => prisma.employee.findUniqueOrThrow({ where: { entraObjectId: oid } });

describe("full and delta sync", () => {
  it("a full sync populates employees, departments and locations", async () => {
    const a = dirUser({ displayName: "Alice Adams", department: "Finance", officeLocation: "HQ", employeeNumber: "E1" });
    const b = dirUser({ displayName: "Bob Brown", department: "Finance", officeLocation: "Annex" });
    const stats = await runFullSync(prisma, new FakeDirectoryProvider([a, b]), eligibility);
    expect(stats).toMatchObject({ created: 2, updated: 0 });
    expect(await prisma.employee.count()).toBe(2);
    expect(await prisma.department.count()).toBe(1);
    expect(await prisma.location.count()).toBe(2);
    const alice = await byOid(a.oid);
    expect(alice).toMatchObject({ employeeNumber: "E1", departmentRaw: "Finance", isEligible: true, accountEnabled: true });
    expect(alice.departmentId).not.toBeNull();
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { name: DELTA_SCHEDULE } })).cursor).toContain("deltatoken");
  });

  it("resolves managers during the full sync", async () => {
    const boss = dirUser({ displayName: "Boss" });
    const worker = dirUser({ displayName: "Worker" });
    const provider = new FakeDirectoryProvider([boss, worker]);
    provider.managers.set(worker.oid, boss.oid);
    await runFullSync(prisma, provider, eligibility);
    expect((await byOid(worker.oid)).managerId).toBe((await byOid(boss.oid)).id);
    expect((await byOid(boss.oid)).managerId).toBeNull();
  });

  it("a delta run changes only the modified users", async () => {
    const users = Array.from({ length: 5 }, () => dirUser());
    const provider = new FakeDirectoryProvider(users);
    await runFullSync(prisma, provider, eligibility);
    const before = await prisma.employee.findMany({ select: { id: true, updatedAt: true } });

    provider.change({ kind: "upsert", user: { ...users[0], jobTitle: "Director" } });
    const stats = await runDeltaSync(prisma, provider, eligibility);
    expect(stats).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect((await byOid(users[0].oid)).jobTitle).toBe("Director");

    const after = await prisma.employee.findMany({ select: { id: true, updatedAt: true } });
    const changedIds = after.filter((a) => a.updatedAt.getTime() !== before.find((b) => b.id === a.id)!.updatedAt.getTime());
    expect(changedIds.map((c) => c.id)).toEqual([(await byOid(users[0].oid)).id]);
  });

  it("re-applying an identical record is reported unchanged and writes nothing meaningful", async () => {
    const u = dirUser();
    const provider = new FakeDirectoryProvider([u]);
    await runFullSync(prisma, provider, eligibility);
    provider.change({ kind: "upsert", user: { ...u } });
    expect(await runDeltaSync(prisma, provider, eligibility)).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it("without a stored cursor a delta run performs a full sync", async () => {
    const provider = new FakeDirectoryProvider([dirUser(), dirUser()]);
    expect(await runDeltaSync(prisma, provider, eligibility)).toMatchObject({ created: 2 });
  });

  it("a user disabled in the directory becomes accountEnabled=false and their UserAccount is disabled (sessions revoked)", async () => {
    const u = dirUser();
    const provider = new FakeDirectoryProvider([u]);
    await runFullSync(prisma, provider, eligibility);
    const emp = await byOid(u.oid);
    const acct = await prisma.userAccount.create({ data: { employeeId: emp.id, role: "agent" } });

    provider.change({ kind: "upsert", user: { ...u, accountEnabled: false } });
    const stats = await runDeltaSync(prisma, provider, eligibility);
    expect(stats.disabled).toBe(1);
    expect((await byOid(u.oid)).accountEnabled).toBe(false);
    const after = await prisma.userAccount.findUniqueOrThrow({ where: { id: acct.id } });
    expect(after).toMatchObject({ status: "disabled", disabledReason: "directory" });
    expect(after.sessionVersion).toBe(acct.sessionVersion + 1);
    expect(await prisma.auditLog.count({ where: { action: "account.disable" } })).toBe(1);
  });

  it("re-enabling in the directory re-enables only accounts the sync itself disabled", async () => {
    const u = dirUser();
    const provider = new FakeDirectoryProvider([u]);
    await runFullSync(prisma, provider, eligibility);
    const emp = await byOid(u.oid);
    const acct = await prisma.userAccount.create({ data: { employeeId: emp.id } });

    provider.change({ kind: "upsert", user: { ...u, accountEnabled: false } });
    await runDeltaSync(prisma, provider, eligibility);
    provider.change({ kind: "upsert", user: { ...u, accountEnabled: true } });
    await runDeltaSync(prisma, provider, eligibility);
    expect((await prisma.userAccount.findUniqueOrThrow({ where: { id: acct.id } })).status).toBe("active");

    // an admin's manual disable must survive a directory re-enable
    await prisma.userAccount.update({ where: { id: acct.id }, data: { status: "disabled", disabledReason: "admin: left the company" } });
    provider.change({ kind: "upsert", user: { ...u, jobTitle: "x" } });
    await runDeltaSync(prisma, provider, eligibility);
    expect((await prisma.userAccount.findUniqueOrThrow({ where: { id: acct.id } })).status).toBe("disabled");
  });

  it("a user removed from the directory is flagged, never hard-deleted, and their account is disabled", async () => {
    const u = dirUser();
    const provider = new FakeDirectoryProvider([u]);
    await runFullSync(prisma, provider, eligibility);
    const emp = await byOid(u.oid);
    await prisma.userAccount.create({ data: { employeeId: emp.id } });
    provider.change({ kind: "removed", oid: u.oid });
    const stats = await runDeltaSync(prisma, provider, eligibility);
    expect(stats).toMatchObject({ removed: 1, disabled: 1 });
    const after = await byOid(u.oid);
    expect(after.directoryDeletedAt).not.toBeNull();
    expect(after.accountEnabled).toBe(false);
    expect(await prisma.employee.count()).toBe(1);
  });

  it("marks guests and service accounts ineligible and disables any account they had", async () => {
    const guest = dirUser({ userType: "Guest" });
    const svc = dirUser({ userPrincipalName: "svc-backup@example.test", mail: null });
    await runFullSync(prisma, new FakeDirectoryProvider([guest, svc, dirUser()]), eligibility);
    expect((await byOid(guest.oid)).isEligible).toBe(false);
    expect((await byOid(svc.oid)).isEligible).toBe(false);
    expect(await prisma.employee.count({ where: { isEligible: true } })).toBe(1);
  });

  it("skips directory objects with a malformed object id", async () => {
    const stats = await runFullSync(prisma, new FakeDirectoryProvider([dirUser({ oid: "not-a-guid" }), dirUser()]), eligibility);
    expect(stats).toMatchObject({ created: 1, skipped: 1 });
  });

  it("updates identity attributes in place when the same oid changes name/UPN/mail (email is not the key)", async () => {
    const u = dirUser({ mail: "old@example.test", userPrincipalName: "old@example.test" });
    const provider = new FakeDirectoryProvider([u]);
    await runFullSync(prisma, provider, eligibility);
    provider.change({ kind: "upsert", user: { ...u, mail: "new@example.test", userPrincipalName: "new@example.test", displayName: "Renamed" } });
    await runDeltaSync(prisma, provider, eligibility);
    expect(await prisma.employee.count()).toBe(1);
    expect(await byOid(u.oid)).toMatchObject({ mail: "new@example.test", displayName: "Renamed" });
  });
});

describe("search", () => {
  async function seed(users: ReturnType<typeof dirUser>[]) {
    await runFullSync(prisma, new FakeDirectoryProvider(users), eligibility);
  }

  it("matches by name, mail, UPN and employee number, case-insensitively, ranking prefix matches first", async () => {
    await seed([
      dirUser({ displayName: "Zed Smith", mail: "zed@example.test", userPrincipalName: "zed@example.test" }),
      dirUser({ displayName: "Ann Smithers", mail: "ann@example.test", userPrincipalName: "ann@example.test", employeeNumber: "E-777" }),
      dirUser({ displayName: "Smith Jones", mail: "sj@example.test", userPrincipalName: "sj@example.test" }),
    ]);
    const r = await searchLocal(prisma, "smith", 10);
    expect(r.map((x) => x.displayName)).toEqual(["Smith Jones", "Ann Smithers", "Zed Smith"]);
    expect((await searchLocal(prisma, "E-777", 10)).map((x) => x.displayName)).toEqual(["Ann Smithers"]);
    expect((await searchLocal(prisma, "ZED@EXAMPLE", 10)).map((x) => x.displayName)).toEqual(["Zed Smith"]);
  });

  it("requires every word to match, in any order", async () => {
    await seed([dirUser({ displayName: "Maria Garcia" }), dirUser({ displayName: "Maria Lopez" })]);
    expect((await searchLocal(prisma, "garcia maria", 10)).map((x) => x.displayName)).toEqual(["Maria Garcia"]);
  });

  it("honours the limit", async () => {
    await seed(Array.from({ length: 12 }, (_, i) => dirUser({ displayName: `Limit Person ${i}` })));
    expect(await searchLocal(prisma, "limit person", 5)).toHaveLength(5);
  });

  it("never returns ineligible, disabled or removed people, and never exposes the Entra object id", async () => {
    const ok = dirUser({ displayName: "Visible Vera" });
    const guest = dirUser({ displayName: "Visible Guest", userType: "Guest" });
    const disabled = dirUser({ displayName: "Visible Disabled", accountEnabled: false });
    const removed = dirUser({ displayName: "Visible Removed" });
    const provider = new FakeDirectoryProvider([ok, guest, disabled, removed]);
    await runFullSync(prisma, provider, eligibility);
    provider.change({ kind: "removed", oid: removed.oid });
    await runDeltaSync(prisma, provider, eligibility);
    const r = await searchLocal(prisma, "visible", 10);
    expect(r.map((x) => x.displayName)).toEqual(["Visible Vera"]);
    expect(Object.keys(r[0])).not.toContain("entraObjectId");
    expect(JSON.stringify(r)).not.toContain(ok.oid);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    await seed([dirUser({ displayName: "Plain Person" }), dirUser({ displayName: "100% Real" })]);
    expect((await searchLocal(prisma, "%", 10)).map((x) => x.displayName)).toEqual(["100% Real"]);
    expect(await searchLocal(prisma, "_____", 10)).toEqual([]);
  });

  it("is safe against SQL metacharacters in the query", async () => {
    await seed([dirUser({ displayName: "Robert" })]);
    expect(await searchLocal(prisma, `'; DROP TABLE "Employee"; --`, 10)).toEqual([]);
    expect(await prisma.employee.count()).toBe(1);
  });

  it("returns department and location names", async () => {
    await seed([dirUser({ displayName: "Dept Dan", department: "Legal", officeLocation: "Remote" })]);
    expect((await searchLocal(prisma, "dept dan", 5))[0]).toMatchObject({ department: "Legal", officeLocation: "Remote" });
  });

  it("answers within 300 ms with 2,000 employees", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      entraObjectId: randomUUID(), userPrincipalName: `user${i}@example.test`, mail: `user${i}@example.test`,
      displayName: `Employee Number ${i} Surname${i % 97}`, employeeNumber: `N${i}`,
    }));
    await prisma.employee.createMany({ data: rows });
    await searchLocal(prisma, "warm", 10); // warm the plan/connection
    const t0 = performance.now();
    const r = await searchLocal(prisma, "surname42", 10);
    const ms = performance.now() - t0;
    expect(r.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
  });
});

describe("graph fallback", () => {
  const seedLocal = (n: number, prefix: string) =>
    prisma.employee.createMany({
      data: Array.from({ length: n }, (_, i) => ({ entraObjectId: randomUUID(), userPrincipalName: `${prefix}${i}@example.test`, displayName: `${prefix} ${i}` })),
    });

  it("is not called when the local database already has 3 or more matches", async () => {
    await seedLocal(3, "Local");
    const provider = new FakeDirectoryProvider();
    const r = await searchEmployees({ db: prisma, provider, eligibility }, "local", 10);
    expect(r).toHaveLength(3);
    expect(provider.searchCalls).toEqual([]);
  });

  it("is not called for queries shorter than 3 characters", async () => {
    const provider = new FakeDirectoryProvider([dirUser({ displayName: "Zo Zo" })]);
    expect(await searchEmployees({ db: prisma, provider, eligibility }, "zo", 10)).toEqual([]);
    expect(provider.searchCalls).toEqual([]);
  });

  it("is called below the threshold, upserts what it finds (eligible only) and re-queries", async () => {
    const found = dirUser({ displayName: "Newhire Nina" });
    const guest = dirUser({ displayName: "Newhire Guest", userType: "Guest" });
    const provider = new FakeDirectoryProvider([found, guest]);
    const r = await searchEmployees({ db: prisma, provider, eligibility }, "newhire", 10);
    expect(provider.searchCalls).toEqual(["newhire"]);
    expect(r.map((x) => x.displayName)).toEqual(["Newhire Nina"]);
    expect(await prisma.employee.count()).toBe(1); // the guest was not stored
  });

  it("a directory failure does not break search", async () => {
    await seedLocal(1, "Resilient");
    const provider = new FakeDirectoryProvider();
    provider.searchUsers = async () => { throw new Error("graph down"); };
    const r = await searchEmployees({ db: prisma, provider, eligibility }, "resilient", 10);
    expect(r).toHaveLength(1);
  });

  it("works with no provider configured (local only)", async () => {
    await seedLocal(1, "Offline");
    expect(await searchEmployees({ db: prisma, provider: null, eligibility }, "offline", 10)).toHaveLength(1);
  });
});

describe("own profile", () => {
  async function me(over: { lastSyncedAt?: Date | null } = {}) {
    const u = dirUser({ displayName: "Self Sam", jobTitle: "Old Title" });
    const e = await prisma.employee.create({
      data: { entraObjectId: u.oid, userPrincipalName: u.userPrincipalName, displayName: u.displayName, jobTitle: "Old Title", lastSyncedAt: over.lastSyncedAt === undefined ? new Date() : over.lastSyncedAt },
    });
    return { u, e };
  }

  it("refreshes from the directory when older than 24h", async () => {
    const { u, e } = await me({ lastSyncedAt: new Date(Date.now() - PROFILE_REFRESH_AFTER_MS - 60_000) });
    const provider = new FakeDirectoryProvider([{ ...u, jobTitle: "New Title" }]);
    const p = await getOwnProfile({ db: prisma, provider, eligibility }, e.id);
    expect(p?.jobTitle).toBe("New Title");
  });

  it("does not call the directory when the data is fresh", async () => {
    const { u, e } = await me();
    const provider = new FakeDirectoryProvider([{ ...u, jobTitle: "New Title" }]);
    let called = 0;
    provider.getUser = async () => { called += 1; return null; };
    const p = await getOwnProfile({ db: prisma, provider, eligibility }, e.id);
    expect(called).toBe(0);
    expect(p?.jobTitle).toBe("Old Title");
  });

  it("a refresh failure is non-fatal, and missing fields come back as null", async () => {
    const { e } = await me({ lastSyncedAt: null });
    const provider = new FakeDirectoryProvider();
    provider.getUser = async () => { throw new Error("graph down"); };
    const p = await getOwnProfile({ db: prisma, provider, eligibility }, e.id);
    expect(p).toMatchObject({ displayName: "Self Sam", mail: null, employeeNumber: null, department: null, officeLocation: null });
  });

  it("returns null for an unknown employee", async () => {
    expect(await getOwnProfile({ db: prisma, provider: null, eligibility }, randomUUID())).toBeNull();
  });
});
