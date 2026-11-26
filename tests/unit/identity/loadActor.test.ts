import { describe, expect, it } from "vitest";
import { loadActor, type ActorDb } from "@/modules/identity/loadActor";
import { UnauthenticatedError } from "@/platform/errors";

type Account = {
  id: string; employeeId: string; status: "active" | "disabled"; role: "employee" | "agent" | "admin"; sessionVersion: number;
  employee: { accountEnabled: boolean; isEligible: boolean; directoryDeletedAt: Date | null };
};

function db(account: Account | null, memberships: { groupId: string; group: { isTriage: boolean; active: boolean } }[] = []) {
  let groupQueries = 0;
  const fake = {
    userAccount: { findUnique: async () => account },
    assignmentGroupMember: { findMany: async () => { groupQueries += 1; return memberships; } },
  };
  return { db: fake as unknown as ActorDb, groupQueries: () => groupQueries };
}

const good = (over: Partial<Account> = {}): Account => ({
  id: "ua1", employeeId: "e1", status: "active", role: "employee", sessionVersion: 3,
  employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: null }, ...over,
});
const claims = { uaid: "ua1", eid: "e1", sv: 3 };

describe("loadActor", () => {
  it("returns the actor for a valid, active session", async () => {
    const { db: d, groupQueries } = db(good());
    await expect(loadActor(d, claims)).resolves.toEqual({ employeeId: "e1", userAccountId: "ua1", role: "employee", groupIds: [], triageGroupIds: [] });
    expect(groupQueries()).toBe(0); // groups are only loaded for agent+
  });

  it("loads groups, and triage groups, for agents", async () => {
    const { db: d } = db(good({ role: "agent" }), [
      { groupId: "g1", group: { isTriage: false, active: true } },
      { groupId: "g2", group: { isTriage: true, active: true } },
    ]);
    const a = await loadActor(d, claims);
    expect(a.groupIds).toEqual(["g1", "g2"]);
    expect(a.triageGroupIds).toEqual(["g2"]);
  });

  const rejected: Array<[string, Account | null]> = [
    ["unknown account", null],
    ["disabled account", good({ status: "disabled" })],
    ["bumped sessionVersion", good({ sessionVersion: 4 })],
    ["account of a different employee", good({ employeeId: "someone-else" })],
    ["employee disabled in the directory", good({ employee: { accountEnabled: false, isEligible: true, directoryDeletedAt: null } })],
    ["employee no longer eligible", good({ employee: { accountEnabled: true, isEligible: false, directoryDeletedAt: null } })],
    ["employee removed from the directory", good({ employee: { accountEnabled: true, isEligible: true, directoryDeletedAt: new Date() } })],
  ];
  for (const [name, account] of rejected) {
    it(`401 for ${name}`, async () => {
      await expect(loadActor(db(account).db, claims)).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  }

  it("401 when the session claims are missing or malformed", async () => {
    const { db: d } = db(good());
    for (const c of [null, undefined, {}, { uaid: "ua1" }, { uaid: "ua1", eid: "e1", sv: "3" as unknown as number }]) {
      await expect(loadActor(d, c as never)).rejects.toBeInstanceOf(UnauthenticatedError);
    }
  });

  it("uses the role from the database, not from anything in the claims", async () => {
    const { db: d } = db(good({ role: "employee" }));
    const a = await loadActor(d, { ...claims, role: "admin" } as never);
    expect(a.role).toBe("employee");
  });
});
