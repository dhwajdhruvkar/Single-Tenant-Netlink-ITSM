import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/platform/http/safeRedirect";

describe("safeRedirectPath", () => {
  it("keeps local paths and queries", () => {
    expect(safeRedirectPath("/desk/tickets/INC0000001?tab=notes")).toBe("/desk/tickets/INC0000001?tab=notes");
  });
  it("defaults to /", () => {
    for (const v of [undefined, null, "", "   "]) expect(safeRedirectPath(v)).toBe("/");
  });
  it("drops the host of absolute URLs (bind address or attacker)", () => {
    expect(safeRedirectPath("http://0.0.0.0:3000/desk")).toBe("/desk");
    expect(safeRedirectPath("https://evil.example/steal")).toBe("/steal");
  });
  it("never produces a protocol-relative or off-site target", () => {
    for (const v of ["//evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "https:evil.example"]) {
      const out = safeRedirectPath(v);
      expect(out.startsWith("/") && !out.startsWith("//"), `${v} -> ${out}`).toBe(true);
    }
  });
});
