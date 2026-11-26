import { describe, expect, it } from "vitest";
import { buildAssistedPayload, buildSelfPayload, EMPTY_AGENT_FIELDS, EMPTY_FORM, IMPACT_FOR, URGENCY_FOR, type TicketFormValues } from "@/ui/tickets/payload";
import { AssistedCreate, SelfServiceCreate } from "@/modules/tickets/contracts";

const filled: TicketFormValues = { ...EMPTY_FORM, subject: "  VPN drops  ", description: " Drops every hour ", categoryId: "11111111-1111-4111-8111-111111111111", contactPhone: " 555-0100 ", locationNote: "Floor 3" , affectedService: "VPN" };
const JANE = "22222222-2222-4222-8222-222222222222";
const FORBIDDEN = ["requesterEmployeeId", "requesterName", "requesterEmail", "requesterDepartment", "requesterJobTitle", "requesterLocation", "requesterId", "createdBy", "createdByEmployeeId", "role", "roles", "status"];

describe("buildSelfPayload (Form B)", () => {
  it("contains no requester, creator, channel or role fields and passes the strict server contract", () => {
    const p = buildSelfPayload(filled);
    for (const k of FORBIDDEN) expect(Object.keys(p)).not.toContain(k);
    expect(Object.keys(p)).not.toContain("channel");
    expect(SelfServiceCreate.safeParse(p).success).toBe(true);
  });
  it("trims text and omits empty optional fields", () => {
    const p = buildSelfPayload({ ...EMPTY_FORM, subject: " Hello there ", description: " d " });
    expect(p).toMatchObject({ subject: "Hello there", description: "d", type: "incident" });
    for (const k of ["categoryId", "contactPhone", "locationNote", "typeDetails"]) expect(Object.keys(p)).not.toContain(k);
  });
  it("translates the plain-language answers into impact and urgency", () => {
    expect(buildSelfPayload({ ...filled, affectedPeople: "many", workImpact: "stopped" })).toMatchObject({ impact: "high", urgency: "high" });
    expect(buildSelfPayload({ ...filled, affectedPeople: "one", workImpact: "normal" })).toMatchObject({ impact: "low", urgency: "low" });
    expect(IMPACT_FOR).toEqual({ one: "low", team: "medium", many: "high" });
    expect(URGENCY_FOR).toEqual({ normal: "low", slowed: "medium", stopped: "high" });
  });
  it("service requests send no impact/urgency and use requestedItem", () => {
    const p = buildSelfPayload({ ...filled, type: "service_request", requestedItem: "Monitor", affectedService: "ignored" });
    expect(Object.keys(p)).not.toContain("impact");
    expect(Object.keys(p)).not.toContain("urgency");
    expect(p.typeDetails).toEqual({ requestedItem: "Monitor" });
  });
});

describe("buildAssistedPayload (Form A)", () => {
  it("identifies the requester by id only and passes the strict server contract", () => {
    const p = buildAssistedPayload(filled, JANE, EMPTY_AGENT_FIELDS);
    expect(p.requesterEmployeeId).toBe(JANE);
    for (const k of FORBIDDEN.filter((k) => k !== "requesterEmployeeId")) expect(Object.keys(p)).not.toContain(k);
    expect(AssistedCreate.safeParse(p).success).toBe(true);
  });
  it("only sends agent fields that were actually chosen", () => {
    const base = buildAssistedPayload(filled, JANE, EMPTY_AGENT_FIELDS);
    for (const k of ["priorityOverride", "assignmentGroupId", "assigneeEmployeeId"]) expect(Object.keys(base)).not.toContain(k);
    const full = buildAssistedPayload(filled, JANE, { ...EMPTY_AGENT_FIELDS, channel: "walk_in", overrideEnabled: true, overridePriority: "p1", overrideReason: " VIP ", assignmentGroupId: "33333333-3333-4333-8333-333333333333", assigneeEmployeeId: "44444444-4444-4444-8444-444444444444" });
    expect(full).toMatchObject({ channel: "walk_in", priorityOverride: { priority: "p1", reason: "VIP" } });
    expect(AssistedCreate.safeParse(full).success).toBe(true);
  });
});
