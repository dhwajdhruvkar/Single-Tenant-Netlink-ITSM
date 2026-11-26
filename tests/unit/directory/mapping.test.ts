import { describe, expect, it } from "vitest";
import { isEligible, parseUpnPrefixes } from "@/modules/directory/eligibility";
import { mapDirectoryUser } from "@/modules/directory/mapping";
import { dirUser } from "../../support/directoryUsers";

describe("mapDirectoryUser", () => {
  it("turns blank and missing attributes into null (nothing is guessed)", () => {
    const f = mapDirectoryUser(dirUser({ givenName: "  ", surname: null, jobTitle: "", department: null, officeLocation: " ", mobilePhone: null, employeeNumber: "" }));
    expect(f).toMatchObject({ givenName: null, surname: null, jobTitle: null, departmentRaw: null, officeLocationRaw: null, mobilePhone: null, employeeNumber: null });
  });
  it("trims values and falls back to the UPN for a blank display name", () => {
    const f = mapDirectoryUser(dirUser({ displayName: " ", userPrincipalName: " jane@example.test ", jobTitle: "  Lead " }));
    expect(f.displayName).toBe("jane@example.test");
    expect(f.userPrincipalName).toBe("jane@example.test");
    expect(f.jobTitle).toBe("Lead");
  });
});

describe("isEligible", () => {
  const cfg = { excludeUpnPrefixes: ["svc-"] };
  it("accepts an enabled Member", () => expect(isEligible(dirUser(), cfg)).toBe(true));
  it("excludes guests and users with no userType", () => {
    expect(isEligible(dirUser({ userType: "Guest" }), cfg)).toBe(false);
    expect(isEligible(dirUser({ userType: null }), cfg)).toBe(false);
  });
  it("excludes service accounts by UPN prefix, case-insensitively", () => {
    expect(isEligible(dirUser({ userPrincipalName: "SVC-backup@example.test" }), cfg)).toBe(false);
    expect(isEligible(dirUser({ userPrincipalName: "svc-backup@example.test" }), { excludeUpnPrefixes: [] })).toBe(true);
  });
  it("optionally requires a company name", () => {
    const withCompany = { ...cfg, companyName: "Netlink" };
    expect(isEligible(dirUser({ companyName: "netlink " }), withCompany)).toBe(true);
    expect(isEligible(dirUser({ companyName: "Other" }), withCompany)).toBe(false);
    expect(isEligible(dirUser({ companyName: null }), withCompany)).toBe(false);
  });
  it("parses prefix lists", () => expect(parseUpnPrefixes(" svc-, Room- ,,")).toEqual(["svc-", "room-"]));
});
