import { describe, expect, it } from "vitest";
import { AssistedCreate, IDEMPOTENCY_KEY, SelfServiceCreate } from "@/modules/tickets/contracts";

const UUID = "11111111-1111-4111-8111-111111111111";
const base = { type: "incident", subject: "Printer is broken", description: "It will not print." };

describe("SelfServiceCreate (Form B)", () => {
  it("accepts a minimal valid body and defaults attachments", () => {
    const r = SelfServiceCreate.parse(base);
    expect(r.attachmentIds).toEqual([]);
  });

  // Form B must never carry identity. .strict() turns every one of these into a 400.
  for (const field of ["requesterEmployeeId", "requesterEmail", "requesterName", "requesterId", "createdBy", "createdByEmployeeId", "requesterDepartment", "role", "channel", "assigneeEmployeeId", "assignmentGroupId", "priorityOverride", "status"]) {
    it(`rejects unknown/identity field "${field}"`, () => {
      expect(SelfServiceCreate.safeParse({ ...base, [field]: field === "priorityOverride" ? { priority: "p1", reason: "boss" } : "x" }).success).toBe(false);
    });
  }

  it("enforces length limits and rejects whitespace-only text", () => {
    expect(SelfServiceCreate.safeParse({ ...base, subject: "ab" }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, subject: "x".repeat(201) }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, subject: "   " }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, description: "   " }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, description: "x".repeat(20001) }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, description: "x".repeat(20000) }).success).toBe(true);
    expect(SelfServiceCreate.safeParse({ ...base, subject: "x".repeat(200) }).success).toBe(true);
  });

  it("trims and accepts unicode", () => {
    const r = SelfServiceCreate.parse({ ...base, subject: "  Imprimante en panne 🖨️  " });
    expect(r.subject).toBe("Imprimante en panne 🖨️");
  });

  it("rejects an invalid type, impact, urgency or category id, and more than 10 attachments", () => {
    expect(SelfServiceCreate.safeParse({ ...base, type: "change" }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, impact: "huge" }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, urgency: "now" }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, categoryId: "not-a-uuid" }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, attachmentIds: Array.from({ length: 11 }, () => UUID) }).success).toBe(false);
    expect(SelfServiceCreate.safeParse({ ...base, attachmentIds: Array.from({ length: 10 }, () => UUID) }).success).toBe(true);
    expect(SelfServiceCreate.safeParse({ ...base, attachmentIds: ["nope"] }).success).toBe(false);
  });
});

describe("AssistedCreate (Form A)", () => {
  const assisted = { ...base, requesterEmployeeId: UUID, channel: "phone" };

  it("requires a requester id and a non-portal channel", () => {
    expect(AssistedCreate.safeParse(assisted).success).toBe(true);
    expect(AssistedCreate.safeParse(base).success).toBe(false);
    expect(AssistedCreate.safeParse({ ...assisted, channel: "portal" }).success).toBe(false);
    expect(AssistedCreate.safeParse({ ...assisted, requesterEmployeeId: "jane@example.test" }).success).toBe(false);
  });

  // Snapshot fields always come from the database, so a client sending them is a 400.
  for (const field of ["requesterName", "requesterEmail", "requesterDepartment", "requesterJobTitle", "requesterLocation", "createdByEmployeeId", "role"]) {
    it(`rejects spoofed field "${field}"`, () => {
      expect(AssistedCreate.safeParse({ ...assisted, [field]: "x" }).success).toBe(false);
    });
  }

  it("validates the priority override (reason required)", () => {
    expect(AssistedCreate.safeParse({ ...assisted, priorityOverride: { priority: "p1", reason: "VIP outage" } }).success).toBe(true);
    expect(AssistedCreate.safeParse({ ...assisted, priorityOverride: { priority: "p1" } }).success).toBe(false);
    expect(AssistedCreate.safeParse({ ...assisted, priorityOverride: { priority: "p1", reason: "x" } }).success).toBe(false);
    expect(AssistedCreate.safeParse({ ...assisted, priorityOverride: { priority: "p9", reason: "because" } }).success).toBe(false);
  });
});

describe("IDEMPOTENCY_KEY", () => {
  it("accepts 8-128 safe characters only", () => {
    expect(IDEMPOTENCY_KEY.test("0d4c1f1e-aaaa-4bbb-8ccc-123456789012")).toBe(true);
    for (const bad of ["short", "has space in it", "x".repeat(129), "semi;colon;key", "new\nline12345"]) expect(IDEMPOTENCY_KEY.test(bad), bad).toBe(false);
  });
});
