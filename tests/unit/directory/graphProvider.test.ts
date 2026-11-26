import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "@/modules/directory/graph/graphClient";
import { fromGraphUser, GraphDirectoryProvider, sanitizeSearchTerm } from "@/modules/directory/graph/graphDirectoryProvider";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(pages: Response[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return pages.shift() ?? json({}, 500);
  });
  return { p: new GraphDirectoryProvider(new GraphClient({ getToken: async () => "t", fetchImpl: fetchImpl as unknown as typeof fetch })), calls };
}

describe("fromGraphUser", () => {
  it("maps fields and the first business phone", () => {
    const u = fromGraphUser({ id: A.toUpperCase(), userPrincipalName: "a@x.test", displayName: "A", businessPhones: ["1", "2"], employeeId: "E1", accountEnabled: false });
    expect(u).toMatchObject({ oid: A, businessPhone: "1", employeeNumber: "E1", accountEnabled: false });
  });
  it("rejects objects without a GUID id or UPN", () => {
    expect(fromGraphUser({ id: "nope", userPrincipalName: "a@x.test" })).toBeNull();
    expect(fromGraphUser({ id: A })).toBeNull();
  });
  it("treats an absent accountEnabled as enabled", () => {
    expect(fromGraphUser({ id: A, userPrincipalName: "a@x.test" })?.accountEnabled).toBe(true);
  });
});

describe("sanitizeSearchTerm", () => {
  it("removes quote/backslash/control characters that could break the $search clause", () => {
    expect(sanitizeSearchTerm('jo"hn \\ smith\n')).toBe("jo hn smith");
  });
});

describe("GraphDirectoryProvider", () => {
  it("search sends ConsistencyLevel: eventual and an escaped $search clause", async () => {
    const { p, calls } = provider([json({ value: [{ id: A, userPrincipalName: "a@x.test" }] })]);
    const r = await p.searchUsers('jo"hn', 10);
    expect(r).toHaveLength(1);
    expect(calls[0].headers.ConsistencyLevel).toBe("eventual");
    expect(decodeURIComponent(calls[0].url)).toContain('"displayName:jo hn" OR "mail:jo hn" OR "userPrincipalName:jo hn"');
    expect(calls[0].url).toContain("$top=10");
  });
  it("does not call Graph for terms shorter than 2 characters", async () => {
    const { p, calls } = provider([]);
    expect(await p.searchUsers("a", 10)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it("follows nextLink pages and returns the deltaLink, mapping removals", async () => {
    const { p, calls } = provider([
      json({ value: [{ id: A, userPrincipalName: "a@x.test" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/delta?$skiptoken=2" }),
      json({ value: [{ id: B, "@removed": { reason: "deleted" } }, { id: "not-a-guid", userPrincipalName: "x" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=9" }),
    ]);
    const r = await p.delta(null);
    expect(r.changes).toEqual([expect.objectContaining({ kind: "upsert" }), { kind: "removed", oid: B }]);
    expect(r.cursor).toContain("deltatoken=9");
    expect(calls).toHaveLength(2);
  });
  it("resumes from a stored cursor, and refuses a cursor that is not a Graph URL", async () => {
    const { p, calls } = provider([json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=10" })]);
    await p.delta("https://graph.microsoft.com/v1.0/users/delta?$deltatoken=9");
    expect(calls[0].url).toContain("deltatoken=9");
    await expect(p.delta("https://evil.example/x")).rejects.toThrow();
  });
  it("fails on a delta page with no continuation instead of looping", async () => {
    const { p } = provider([json({ value: [] })]);
    await expect(p.delta(null)).rejects.toThrow(/neither/);
  });
  it("getManagerOid returns the manager id, or null on 404 / bad input", async () => {
    expect(await provider([json({ id: B })]).p.getManagerOid(A)).toBe(B);
    expect(await provider([json({}, 404)]).p.getManagerOid(A)).toBeNull();
    expect(await provider([]).p.getManagerOid("../../x")).toBeNull();
  });
  it("getUser returns null for 404 and for a non-GUID without calling Graph", async () => {
    const { p, calls } = provider([json({}, 404)]);
    expect(await p.getUser(A)).toBeNull();
    expect(await p.getUser("nope")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
