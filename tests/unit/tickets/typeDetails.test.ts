import { describe, expect, it } from "vitest";
import { sanitizeTypeDetails } from "@/modules/tickets/typeDetails";

describe("sanitizeTypeDetails", () => {
  it("keeps only the fields valid for the type", () => {
    expect(sanitizeTypeDetails("incident", { affectedService: " VPN ", requestedItem: "laptop", evil: "<script>" })).toEqual({ affectedService: "VPN" });
    expect(sanitizeTypeDetails("service_request", { requestedItem: "Laptop", fulfilmentDetails: "Blue", affectedService: "x" })).toEqual({ requestedItem: "Laptop", fulfilmentDetails: "Blue" });
  });
  it("never accepts an approval flag from the caller", () => {
    expect(sanitizeTypeDetails("service_request", { approvalRequired: false })).toBeNull();
  });
  it("drops wrong types and over-long values, returning null when nothing is left", () => {
    expect(sanitizeTypeDetails("incident", { affectedService: 42 })).toBeNull();
    expect(sanitizeTypeDetails("incident", { affectedService: "x".repeat(201) })).toBeNull();
    expect(sanitizeTypeDetails("service_request", { fulfilmentDetails: "x".repeat(4001) })).toBeNull();
    expect(sanitizeTypeDetails("incident", { affectedService: "   " })).toBeNull();
  });
  it("ignores non-objects", () => {
    for (const v of [null, undefined, "x", 5, [], [{ affectedService: "a" }]]) expect(sanitizeTypeDetails("incident", v)).toBeNull();
  });
});
