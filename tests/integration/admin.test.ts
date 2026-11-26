import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CategoryCreate, createCategory, updateCategory } from "@/modules/admin/categories";
import { addMember, createGroup, GroupCreate, listGroups, removeMember, updateGroup } from "@/modules/admin/groups";
import { addHoliday, CalendarCreate, createCalendar, createPolicy, isValidTimeZone, listSla, PolicyCreate, removeHoliday, updateCalendar, updatePolicy } from "@/modules/admin/sla";
import { computeSlaDues } from "@/modules/sla/policy";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
const deps = { db: prisma };
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const audit = (action: string) => prisma.auditLog.findMany({ where: { action } });

describe("only admins can configure", () => {
  it("every admin service refuses employees, submitters, agents and managers with 403 and writes nothing", async () => {
    const g = await prisma.assignmentGroup.create({ data: { name: "Existing" } });
    const person = await W.person();
    for (const role of ["employee", "submitter", "agent", "manager"] as const) {
      const a = await W.actor(role);
      const calls: Array<() => Promise<unknown>> = [
        () => listGroups(prisma, a), () => createGroup(deps, a, GroupCreate.parse({ name: "Nope" })), () => updateGroup(deps, a, g.id, { active: false }),
        () => addMember(deps, a, g.id, { employeeId: person.id, role: "member" }), () => removeMember(deps, a, g.id, person.id),
        () => createCategory(deps, a, CategoryCreate.parse({ name: "Nope" })), () => listSla(prisma, a),
        () => createPolicy(deps, a, PolicyCreate.parse({ name: "x", priority: "p1", responseMinutes: 5, resolveMinutes: 60 })),
        () => createCalendar(deps, a, CalendarCreate.parse({ name: "x", timezone: "UTC", workDays: [1], startMinute: 0, endMinute: 60 })),
      ];
      for (const call of calls) await expect(call(), role).rejects.toMatchObject({ status: 403 });
    }
    expect(await prisma.assignmentGroup.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("PATCH schemas do not apply create-time defaults", () => {
  it("a partial update contains only the fields that were sent", async () => {
    const { GroupUpdate } = await import("@/modules/admin/groups");
    const { CategoryUpdate } = await import("@/modules/admin/categories");
    expect(GroupUpdate.parse({ active: false })).toEqual({ active: false });
    expect(GroupUpdate.parse({})).toEqual({});
    expect(CategoryUpdate.parse({ active: false })).toEqual({ active: false });
    expect(CategoryUpdate.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("deactivating a group keeps its strategy and triage flag; deactivating a category keeps its types and order", async () => {
    const admin = await W.actor("admin");
    const { GroupUpdate } = await import("@/modules/admin/groups");
    const { CategoryUpdate } = await import("@/modules/admin/categories");
    const g = await createGroup(deps, admin, GroupCreate.parse({ name: "Triage", strategy: "round_robin", isTriage: true }));
    await updateGroup(deps, admin, g.id, GroupUpdate.parse({ active: false }));
    expect(await prisma.assignmentGroup.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ strategy: "round_robin", isTriage: true, active: false });
    const c = await createCategory(deps, admin, CategoryCreate.parse({ name: "Hardware", ticketTypes: ["service_request"], sortOrder: 7 }));
    await updateCategory(deps, admin, c.id, CategoryUpdate.parse({ active: false }));
    expect(await prisma.category.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ ticketTypes: ["service_request"], sortOrder: 7, active: false });
  });
});

describe("groups and members", () => {
  it("creates, updates and audits a group; duplicate names are 409", async () => {
    const admin = await W.actor("admin");
    const { id } = await createGroup(deps, admin, GroupCreate.parse({ name: "Network", strategy: "round_robin", isTriage: false, email: "net@example.test" }));
    expect(await prisma.assignmentGroup.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Network", strategy: "round_robin", email: "net@example.test", active: true });
    await expect(createGroup(deps, admin, GroupCreate.parse({ name: "Network" }))).rejects.toMatchObject({ status: 409 });
    await updateGroup(deps, admin, id, { strategy: "least_loaded", active: false });
    const a = (await audit("group.update"))[0];
    expect(a.changes).toEqual({ strategy: ["round_robin", "least_loaded"], active: [true, false] });
    expect(a.actorEmployeeId).toBe(admin.employeeId);
    expect(await audit("group.create")).toHaveLength(1);
  });

  it("rejects an empty update, a no-op update, an unknown group, and invalid input", async () => {
    const admin = await W.actor("admin");
    const { id } = await createGroup(deps, admin, GroupCreate.parse({ name: "Gr" }));
    await expect(updateGroup(deps, admin, id, {})).rejects.toMatchObject({ status: 400 });
    await expect(updateGroup(deps, admin, id, { name: "Gr" })).rejects.toMatchObject({ status: 400 });
    await expect(updateGroup(deps, admin, randomUUID(), { active: false })).rejects.toMatchObject({ status: 404 });
    expect(GroupCreate.safeParse({ name: "x" }).success).toBe(false);
    expect(GroupCreate.safeParse({ name: "Okay", strategy: "random" }).success).toBe(false);
    expect(GroupCreate.safeParse({ name: "Okay", email: "not-an-email" }).success).toBe(false);
    expect(GroupCreate.safeParse({ name: "Okay", rrCursor: 5 }).success).toBe(false); // strict: internal fields cannot be set
  });

  it("adds and removes members; only eligible, enabled, current people can be added", async () => {
    const admin = await W.actor("admin");
    const { id } = await createGroup(deps, admin, GroupCreate.parse({ name: "Desk" }));
    const ok = await W.person();
    await addMember(deps, admin, id, { employeeId: ok.id, role: "lead" });
    expect(await prisma.assignmentGroupMember.findFirstOrThrow({ where: { groupId: id } })).toMatchObject({ employeeId: ok.id, role: "lead" });
    await addMember(deps, admin, id, { employeeId: ok.id, role: "member" }); // idempotent: changes the role
    expect(await prisma.assignmentGroupMember.count()).toBe(1);
    expect((await prisma.assignmentGroupMember.findFirstOrThrow()).role).toBe("member");
    for (const bad of [await W.person({ accountEnabled: false }), await W.person({ isEligible: false }), await W.person({ directoryDeletedAt: new Date() })]) {
      await expect(addMember(deps, admin, id, { employeeId: bad.id, role: "member" })).rejects.toMatchObject({ status: 422, code: "EMPLOYEE_NOT_ELIGIBLE" });
    }
    await expect(addMember(deps, admin, id, { employeeId: randomUUID(), role: "member" })).rejects.toMatchObject({ status: 422 });
    await expect(addMember(deps, admin, randomUUID(), { employeeId: ok.id, role: "member" })).rejects.toMatchObject({ status: 404 });
    await removeMember(deps, admin, id, ok.id);
    await expect(removeMember(deps, admin, id, ok.id)).rejects.toMatchObject({ status: 404 });
    expect(await audit("group.member_add")).toHaveLength(2);
    expect(await audit("group.member_remove")).toHaveLength(1);
  });

  it("listGroups returns members with availability", async () => {
    const admin = await W.actor("admin");
    const { id } = await createGroup(deps, admin, GroupCreate.parse({ name: "Desk" }));
    const p = await W.person({ displayName: "Zed" });
    await addMember(deps, admin, id, { employeeId: p.id, role: "member" });
    await prisma.employee.update({ where: { id: p.id }, data: { accountEnabled: false } });
    expect((await listGroups(prisma, admin))[0].members[0]).toMatchObject({ displayName: "Zed", available: false });
  });

  it("a failed audit write rolls the change back", async () => {
    const admin = await W.actor("admin");
    await expect(createGroup({ db: prisma, audit: async () => { throw new Error("audit down"); } }, admin, GroupCreate.parse({ name: "Ghost" }))).rejects.toThrow(/audit down/);
    expect(await prisma.assignmentGroup.count()).toBe(0);
  });
});

describe("categories", () => {
  it("creates a tree, validates the default group, and prevents duplicates (including top level)", async () => {
    const admin = await W.actor("admin");
    const g = await prisma.assignmentGroup.create({ data: { name: "Net" } });
    const parent = await createCategory(deps, admin, CategoryCreate.parse({ name: "Network", defaultGroupId: g.id, defaultImpact: "high" }));
    const child = await createCategory(deps, admin, CategoryCreate.parse({ name: "VPN", parentId: parent.id, ticketTypes: ["incident"] }));
    expect(await prisma.category.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({ parentId: parent.id, ticketTypes: ["incident"] });
    await expect(createCategory(deps, admin, CategoryCreate.parse({ name: "Network" }))).rejects.toMatchObject({ status: 409 }); // NULL parent: checked in code
    await expect(createCategory(deps, admin, CategoryCreate.parse({ name: "VPN", parentId: parent.id }))).rejects.toMatchObject({ status: 409 });
    await expect(createCategory(deps, admin, CategoryCreate.parse({ name: "VPN" }))).resolves.toBeDefined(); // same name under another parent is fine
    const dead = await prisma.assignmentGroup.create({ data: { name: "Dead", active: false } });
    await expect(createCategory(deps, admin, CategoryCreate.parse({ name: "X", defaultGroupId: dead.id }))).rejects.toMatchObject({ code: "GROUP_INVALID" });
    await expect(createCategory(deps, admin, CategoryCreate.parse({ name: "Y", parentId: randomUUID() }))).rejects.toMatchObject({ status: 422 });
  });

  it("refuses cycles", async () => {
    const admin = await W.actor("admin");
    const a = await createCategory(deps, admin, CategoryCreate.parse({ name: "A" }));
    const b = await createCategory(deps, admin, CategoryCreate.parse({ name: "B", parentId: a.id }));
    const c = await createCategory(deps, admin, CategoryCreate.parse({ name: "C", parentId: b.id }));
    await expect(updateCategory(deps, admin, a.id, { parentId: a.id })).rejects.toMatchObject({ code: "CATEGORY_CYCLE" });
    await expect(updateCategory(deps, admin, a.id, { parentId: c.id })).rejects.toMatchObject({ code: "CATEGORY_CYCLE" });
    await expect(updateCategory(deps, admin, c.id, { parentId: null })).resolves.toBeDefined();
  });

  it("updates fields, deactivates, audits the change, and rejects no-ops and unknown ids", async () => {
    const admin = await W.actor("admin");
    const c = await createCategory(deps, admin, CategoryCreate.parse({ name: "Printers" }));
    await updateCategory(deps, admin, c.id, { name: "Printing", active: false, sortOrder: 5 });
    expect((await audit("category.update"))[0].changes).toEqual({ name: ["Printers", "Printing"], active: [true, false], sortOrder: [0, 5] });
    await expect(updateCategory(deps, admin, c.id, { name: "Printing" })).rejects.toMatchObject({ status: 400 });
    await expect(updateCategory(deps, admin, randomUUID(), { active: true })).rejects.toMatchObject({ status: 404 });
    expect(CategoryCreate.safeParse({ name: "x", ticketTypes: ["change"] }).success).toBe(false);
  });

  it("a deactivated category is no longer accepted on new tickets", async () => {
    const admin = await W.actor("admin");
    const c = await createCategory(deps, admin, CategoryCreate.parse({ name: "Old" }));
    await updateCategory(deps, admin, c.id, { active: false });
    const { createTicket } = await import("@/modules/tickets/createTicket");
    await expect(createTicket(deps, await W.actor("employee"), { type: "incident", subject: "Uses old category", description: "d", attachmentIds: [], requester: { kind: "self" }, channel: "portal", categoryId: c.id })).rejects.toMatchObject({ code: "CATEGORY_INVALID" });
  });
});

describe("calendars, holidays and SLA policies", () => {
  const cal = { name: "NY hours", timezone: "America/New_York", workDays: [5, 1, 2, 3, 4, 4], startMinute: 540, endMinute: 1080 };

  it("validates calendars: time zone, hours, work days", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(CalendarCreate.safeParse({ ...cal, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(CalendarCreate.safeParse({ ...cal, startMinute: 600, endMinute: 600 }).success).toBe(false);
    expect(CalendarCreate.safeParse({ ...cal, endMinute: 1441 }).success).toBe(false);
    expect(CalendarCreate.safeParse({ ...cal, workDays: [] }).success).toBe(false);
    expect(CalendarCreate.safeParse({ ...cal, workDays: [0, 8] }).success).toBe(false);
    expect(CalendarCreate.parse(cal).workDays).toEqual([1, 2, 3, 4, 5]); // de-duplicated and sorted
  });

  it("creates a calendar, edits it (hours must stay consistent), and manages holidays", async () => {
    const admin = await W.actor("admin");
    const { id } = await createCalendar(deps, admin, CalendarCreate.parse(cal));
    await expect(createCalendar(deps, admin, CalendarCreate.parse(cal))).rejects.toMatchObject({ status: 409 });
    await updateCalendar(deps, admin, id, { endMinute: 1020 });
    await expect(updateCalendar(deps, admin, id, { startMinute: 1020 })).rejects.toMatchObject({ code: "CALENDAR_HOURS" });
    const h = await addHoliday(deps, admin, id, { date: "2026-12-25", name: "Christmas" });
    await expect(addHoliday(deps, admin, id, { date: "2026-12-25", name: "Again" })).rejects.toMatchObject({ status: 409 });
    expect((await listSla(prisma, admin)).calendars[0].holidays).toEqual([{ id: h.id, date: "2026-12-25", name: "Christmas" }]);
    await removeHoliday(deps, admin, id, h.id);
    await expect(removeHoliday(deps, admin, id, h.id)).rejects.toMatchObject({ status: 404 });
    await expect(addHoliday(deps, admin, randomUUID(), { date: "2026-01-01", name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("creates SLA policies; only one ACTIVE policy per priority and type (409), but a deactivated one frees the slot", async () => {
    const admin = await W.actor("admin");
    const mk = (over: object = {}) => createPolicy(deps, admin, PolicyCreate.parse({ name: `p-${Math.random()}`, priority: "p1", responseMinutes: 15, resolveMinutes: 240, ...over }));
    const first = await mk();
    await expect(mk()).rejects.toMatchObject({ status: 409 });
    await expect(mk({ ticketType: "incident" })).resolves.toBeDefined(); // type-specific is a different slot
    await expect(mk({ ticketType: "incident" })).rejects.toMatchObject({ status: 409 });
    await updatePolicy(deps, admin, first.id, { active: false });
    await expect(mk()).resolves.toBeDefined();
    await expect(updatePolicy(deps, admin, first.id, { active: true })).rejects.toMatchObject({ status: 409 }); // would clash again
    await expect(createPolicy(deps, admin, PolicyCreate.parse({ name: "bad cal", priority: "p2", responseMinutes: 5, resolveMinutes: 30, calendarId: randomUUID() }))).rejects.toMatchObject({ code: "CALENDAR_INVALID" });
  });

  it("validates minutes and audits policy changes", async () => {
    const admin = await W.actor("admin");
    expect(PolicyCreate.safeParse({ name: "x", priority: "p1", responseMinutes: 0, resolveMinutes: 10 }).success).toBe(false);
    expect(PolicyCreate.safeParse({ name: "x", priority: "p9", responseMinutes: 5, resolveMinutes: 10 }).success).toBe(false);
    expect(PolicyCreate.safeParse({ name: "x", priority: "p1", responseMinutes: 5.5, resolveMinutes: 10 }).success).toBe(false);
    const p = await createPolicy(deps, admin, PolicyCreate.parse({ name: "P3 std", priority: "p3", responseMinutes: 60, resolveMinutes: 480 }));
    await updatePolicy(deps, admin, p.id, { resolveMinutes: 600 });
    expect((await audit("sla_policy.update"))[0].changes).toEqual({ resolveMinutes: [480, 600] });
  });

  it("a policy change affects tickets created afterwards, not existing ones", async () => {
    const admin = await W.actor("admin");
    const p = await createPolicy(deps, admin, PolicyCreate.parse({ name: "P3", priority: "p3", responseMinutes: 60, resolveMinutes: 480 }));
    const created = new Date("2026-03-04T12:00:00Z");
    const before = await computeSlaDues(prisma, { priority: "p3", type: "incident", createdAt: created });
    await updatePolicy(deps, admin, p.id, { resolveMinutes: 120 });
    const after = await computeSlaDues(prisma, { priority: "p3", type: "incident", createdAt: created });
    expect(before.resolveDueAt?.toISOString()).toBe("2026-03-04T20:00:00.000Z");
    expect(after.resolveDueAt?.toISOString()).toBe("2026-03-04T14:00:00.000Z");
  });

  it("a policy bound to a business calendar produces business-time due dates", async () => {
    const admin = await W.actor("admin");
    const c = await createCalendar(deps, admin, CalendarCreate.parse(cal));
    await addHoliday(deps, admin, c.id, { date: "2026-03-09", name: "Company day" });
    await createPolicy(deps, admin, PolicyCreate.parse({ name: "P3 biz", priority: "p3", responseMinutes: 60, resolveMinutes: 480, calendarId: c.id }));
    const dues = await computeSlaDues(prisma, { priority: "p3", type: "incident", createdAt: new Date("2026-03-06T22:30:00Z") }); // Fri 17:30 EST
    expect(dues.responseDueAt?.toISOString()).toBe("2026-03-10T13:30:00.000Z"); // Mon is a holiday -> Tue 09:30 EDT
  });
});
