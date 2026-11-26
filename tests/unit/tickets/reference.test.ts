import { describe, expect, it } from "vitest";
import { formatReference } from "@/modules/tickets/reference";

describe("formatReference", () => {
  it("formats incident and request references", () => {
    expect(formatReference("incident", 1042)).toBe("INC0001042");
    expect(formatReference("service_request", 1043n)).toBe("REQ0001043");
  });
  it("does not truncate numbers longer than 7 digits", () => {
    expect(formatReference("incident", 123456789)).toBe("INC123456789");
  });
  it("rejects non-positive numbers", () => {
    expect(() => formatReference("incident", 0)).toThrow(RangeError);
  });
});
