import { describe, expect, it } from "vitest";
import { readEntraClaims } from "@/modules/identity/claims";

const TID = "11111111-1111-1111-1111-111111111111";
const OID = "AAAAAAAA-2222-3333-4444-555555555555";
const base = { tid: TID, oid: OID, preferred_username: "jane@example.com", name: "Jane Doe", email: "jane@example.com", roles: ["ITSM.Agent"] };

describe("readEntraClaims", () => {
  it("accepts a valid token and lower-cases ids", () => {
    const r = readEntraClaims(base, TID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.oid).toBe(OID.toLowerCase());
      expect(r.claims.upn).toBe("jane@example.com");
      expect(r.claims.roles).toEqual(["ITSM.Agent"]);
    }
  });
  it("denies a tenant mismatch or missing tid", () => {
    expect(readEntraClaims({ ...base, tid: "99999999-9999-9999-9999-999999999999" }, TID)).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(readEntraClaims({ ...base, tid: undefined }, TID)).toEqual({ ok: false, reason: "tenant_mismatch" });
  });
  it("denies a missing or malformed oid", () => {
    expect(readEntraClaims({ ...base, oid: undefined }, TID)).toEqual({ ok: false, reason: "invalid_oid" });
    expect(readEntraClaims({ ...base, oid: "not-a-guid" }, TID)).toEqual({ ok: false, reason: "invalid_oid" });
    expect(readEntraClaims({ ...base, oid: 12345 }, TID)).toEqual({ ok: false, reason: "invalid_oid" });
  });
  it("does not accept the pairwise sub claim in place of oid", () => {
    expect(readEntraClaims({ ...base, oid: undefined, sub: OID }, TID)).toEqual({ ok: false, reason: "invalid_oid" });
  });
  it("denies when there is no profile", () => {
    expect(readEntraClaims(undefined, TID)).toEqual({ ok: false, reason: "invalid_oid" });
  });
  it("tolerates missing optional claims", () => {
    const r = readEntraClaims({ tid: TID, oid: OID, preferred_username: "jane@example.com" }, TID);
    expect(r.ok && r.claims.displayName).toBe("jane@example.com");
    expect(r.ok && r.claims.roles).toEqual([]);
  });
});
