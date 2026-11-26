import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EntraClaims } from "@/modules/identity/claims";
import { loadActor } from "@/modules/identity/loadActor";
import { DEFAULT_ROLE_MAPPING } from "@/modules/identity/roleMapping";
import { handleSignIn, recordSignInDenied } from "@/modules/identity/signInService";
import { UnauthenticatedError } from "@/platform/errors";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await disconnect();
});

const claims = (over: Partial<EntraClaims> = {}): EntraClaims => ({
  oid: randomUUID(),
  tid: "11111111-1111-1111-1111-111111111111",
  upn: "jane@example.test",
  displayName: "Jane Doe",
  email: "jane@example.test",
  roles: [],
  ...over,
});
const signIn = (c: EntraClaims) => handleSignIn(prisma, c, DEFAULT_ROLE_MAPPING);

describe("first sign-in", () => {
  it("creates an Employee keyed by oid and a UserAccount with the default employee role", async () => {
    const c = claims();
    const r = await signIn(c);
    expect(r).toMatchObject({ allowed: true, role: "employee" });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { entraObjectId: c.oid } });
    expect(emp.userPrincipalName).toBe("jane@example.test");
    const acct = await prisma.userAccount.findUniqueOrThrow({ where: { employeeId: emp.id } });
    expect(acct.status).toBe("active");
    expect(acct.lastSignInAt).not.toBeNull();
  });

  it("is idempotent: the same oid with a changed UPN and mail maps to the same Employee", async () => {
    const c = claims();
    const a = await signIn(c);
    const b = await signIn({ ...c, upn: "jane.doe@example.test", email: "jane.doe@example.test", displayName: "Jane Q. Doe" });
    expect(a.allowed && b.allowed && a.employeeId === b.employeeId && a.userAccountId === b.userAccountId).toBe(true);
    expect(await prisma.employee.count()).toBe(1);
    expect(await prisma.userAccount.count()).toBe(1);
    const emp = await prisma.employee.findUniqueOrThrow({ where: { entraObjectId: c.oid } });
    expect(emp).toMatchObject({ userPrincipalName: "jane.doe@example.test", mail: "jane.doe@example.test", displayName: "Jane Q. Doe" });
  });

  it("survives concurrent first sign-ins of the same person", async () => {
    const c = claims();
    const results = await Promise.all(Array.from({ length: 8 }, () => signIn(c)));
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(await prisma.employee.count()).toBe(1);
    expect(await prisma.userAccount.count()).toBe(1);
  });

  it("does not collide when two different people share a mail value", async () => {
    const a = await signIn(claims({ upn: "a@example.test", email: "shared@example.test" }));
    const b = await signIn(claims({ upn: "b@example.test", email: "shared@example.test" }));
    expect(a.allowed && b.allowed).toBe(true);
    expect(await prisma.employee.count()).toBe(2);
  });

  it("identifies people by oid even if the email later moves to another person", async () => {
    const first = claims({ email: "taken@example.test" });
    await signIn(first);
    const second = claims({ email: "taken@example.test" });
    const r = await signIn(second);
    expect(r.allowed).toBe(true);
    expect(await prisma.employee.count()).toBe(2);
  });
});

describe("role sync", () => {
  it("grants Entra roles and uses the highest as the effective role", async () => {
    const c = claims({ roles: ["ITSM.Agent", "ITSM.Manager", "Unknown.Role"] });
    const r = await signIn(c);
    expect(r).toMatchObject({ allowed: true, role: "manager" });
    const acct = await prisma.userAccount.findUniqueOrThrow({ where: { id: r.allowed ? r.userAccountId : "" }, include: { roles: true } });
    expect(acct.role).toBe("manager");
    expect(acct.roles.map((x) => x.role).sort()).toEqual(["agent", "manager"]);
    expect(acct.roles.every((x) => x.source === "entra")).toBe(true);
  });

  it("removes a role at the next sign-in when Entra no longer grants it", async () => {
    const c = claims({ roles: ["ITSM.Admin"] });
    expect(await signIn(c)).toMatchObject({ role: "admin" });
    expect(await signIn({ ...c, roles: [] })).toMatchObject({ role: "employee" });
    expect(await prisma.userAccountRole.count()).toBe(0);
  });

  it("preserves manual grants across sign-ins", async () => {
    const c = claims();
    const first = await signIn(c);
    if (!first.allowed) throw new Error("expected allowed");
    await prisma.userAccountRole.create({ data: { userAccountId: first.userAccountId, role: "agent", source: "manual", grantedById: first.employeeId } });
    const again = await signIn({ ...c, roles: ["ITSM.Submitter"] });
    expect(again).toMatchObject({ allowed: true, role: "agent" });
    const roles = await prisma.userAccountRole.findMany({ where: { userAccountId: first.userAccountId } });
    expect(roles.map((r) => `${r.role}:${r.source}`).sort()).toEqual(["agent:manual", "submitter:entra"]);
    // and removing the Entra role later still keeps the manual one
    expect(await signIn({ ...c, roles: [] })).toMatchObject({ role: "agent" });
  });
});

describe("denials", () => {
  it("denies an admin-disabled account regardless of Entra, and audits it", async () => {
    const c = claims({ roles: ["ITSM.Admin"] });
    const first = await signIn(c);
    if (!first.allowed) throw new Error("expected allowed");
    await prisma.userAccount.update({ where: { id: first.userAccountId }, data: { status: "disabled" } });
    expect(await signIn(c)).toEqual({ allowed: false, reason: "account_disabled" });
    const audit = await prisma.auditLog.findMany({ where: { action: "auth.signin_denied" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toEqual({ reason: "account_disabled" });
    expect(audit[0].actorEmployeeId).toBe(first.employeeId);
  });

  it("denies people disabled, ineligible or removed in the directory", async () => {
    const mk = async (data: object) => {
      const c = claims();
      await signIn(c);
      await prisma.employee.update({ where: { entraObjectId: c.oid }, data });
      return signIn(c);
    };
    expect(await mk({ accountEnabled: false })).toEqual({ allowed: false, reason: "directory_disabled" });
    expect(await mk({ isEligible: false })).toEqual({ allowed: false, reason: "not_eligible" });
    expect(await mk({ directoryDeletedAt: new Date() })).toEqual({ allowed: false, reason: "directory_removed" });
  });

  it("audits a rejection that happens before any Employee exists (e.g. wrong tenant) without storing claims", async () => {
    await recordSignInDenied(prisma, "tenant_mismatch");
    const rows = await prisma.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "auth.signin_denied", actorEmployeeId: null, changes: { reason: "tenant_mismatch" } });
    expect(await prisma.employee.count()).toBe(0);
  });

  it("writes an auth.signin audit row on success, recording role changes", async () => {
    const c = claims({ roles: ["ITSM.Agent"] });
    await signIn(c);
    const rows = await prisma.auditLog.findMany({ where: { action: "auth.signin" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].changes).toEqual({ role: ["employee", "agent"] });
  });
});

describe("per-request actor check against the real database", () => {
  async function signedIn(roles: string[] = []) {
    const r = await signIn(claims({ roles }));
    if (!r.allowed) throw new Error("expected allowed");
    return { uaid: r.userAccountId, eid: r.employeeId, sv: r.sessionVersion };
  }

  it("resolves an actor, and for agents their groups and triage groups", async () => {
    const s = await signedIn(["ITSM.Agent"]);
    const triage = await prisma.assignmentGroup.create({ data: { name: "Service Desk", isTriage: true } });
    const net = await prisma.assignmentGroup.create({ data: { name: "Network" } });
    await prisma.assignmentGroupMember.createMany({ data: [{ groupId: triage.id, employeeId: s.eid }, { groupId: net.id, employeeId: s.eid }] });
    const actor = await loadActor(prisma, s);
    expect(actor.role).toBe("agent");
    expect([...actor.groupIds].sort()).toEqual([triage.id, net.id].sort());
    expect(actor.triageGroupIds).toEqual([triage.id]);
  });

  it("ignores inactive groups", async () => {
    const s = await signedIn(["ITSM.Agent"]);
    const g = await prisma.assignmentGroup.create({ data: { name: "Old", active: false } });
    await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: s.eid } });
    expect((await loadActor(prisma, s)).groupIds).toEqual([]);
  });

  it("returns 401 on the next call after the account is disabled", async () => {
    const s = await signedIn();
    await loadActor(prisma, s);
    await prisma.userAccount.update({ where: { id: s.uaid }, data: { status: "disabled" } });
    await expect(loadActor(prisma, s)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("returns 401 after sessionVersion is bumped", async () => {
    const s = await signedIn();
    await prisma.userAccount.update({ where: { id: s.uaid }, data: { sessionVersion: { increment: 1 } } });
    await expect(loadActor(prisma, s)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("returns 401 once the employee is disabled in the directory", async () => {
    const s = await signedIn();
    await prisma.employee.update({ where: { id: s.eid }, data: { accountEnabled: false } });
    await expect(loadActor(prisma, s)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("picks up a role change on the very next request without a new sign-in", async () => {
    const s = await signedIn();
    await prisma.userAccount.update({ where: { id: s.uaid }, data: { role: "manager" } });
    expect((await loadActor(prisma, s)).role).toBe("manager");
  });
});
