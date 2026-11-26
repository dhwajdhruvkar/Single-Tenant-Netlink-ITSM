import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_MAPPING, highestRole, mapEntraRoles } from "@/modules/identity/roleMapping";

describe("mapEntraRoles", () => {
  it("maps the four Entra app roles", () => {
    expect(mapEntraRoles(["ITSM.Agent"]).sort()).toEqual(["agent"]);
    expect(mapEntraRoles(["ITSM.Manager", "ITSM.Submitter"]).sort()).toEqual(["manager", "submitter"]);
    expect(mapEntraRoles(["ITSM.Admin"])).toEqual(["admin"]);
  });
  it("ignores unknown values, case-variants, non-strings and non-arrays", () => {
    expect(mapEntraRoles(["Global.Admin", "itsm.admin", 7, null, "ITSM.User"])).toEqual([]);
    expect(mapEntraRoles(undefined)).toEqual([]);
    expect(mapEntraRoles("ITSM.Admin")).toEqual([]);
  });
  it("honours configured role values", () => {
    const mapping = { ...DEFAULT_ROLE_MAPPING, agent: "Helpdesk.Agent" };
    expect(mapEntraRoles(["Helpdesk.Agent"], mapping)).toEqual(["agent"]);
    expect(mapEntraRoles(["ITSM.Agent"], mapping)).toEqual([]);
  });
});

describe("highestRole", () => {
  it("defaults to employee", () => expect(highestRole([])).toBe("employee"));
  it("highest wins", () => {
    expect(highestRole(["agent", "submitter"])).toBe("agent");
    expect(highestRole(["agent", "admin", "manager"])).toBe("admin");
    expect(highestRole(["submitter"])).toBe("submitter");
  });
});
