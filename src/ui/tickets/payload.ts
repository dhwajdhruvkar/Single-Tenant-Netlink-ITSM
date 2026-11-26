// Pure builders for the request bodies of both forms. They list fields explicitly (an allow-list), so nothing about the
// requester's identity, snapshot data or role can leak into a request by accident.

export type AffectedPeople = "one" | "team" | "many";
export type WorkImpact = "normal" | "slowed" | "stopped";

export interface TicketFormValues {
  type: "incident" | "service_request";
  categoryId: string;
  subject: string;
  description: string;
  affectedPeople: AffectedPeople;
  workImpact: WorkImpact;
  contactPhone: string;
  locationNote: string;
  affectedService: string;
  requestedItem: string;
}

export const EMPTY_FORM: TicketFormValues = {
  type: "incident", categoryId: "", subject: "", description: "", affectedPeople: "one", workImpact: "slowed",
  contactPhone: "", locationNote: "", affectedService: "", requestedItem: "",
};

// Plain-language questions instead of asking people for "impact" and "urgency" (idea carried over from the original portal).
export const IMPACT_FOR: Record<AffectedPeople, "low" | "medium" | "high"> = { one: "low", team: "medium", many: "high" };
export const URGENCY_FOR: Record<WorkImpact, "low" | "medium" | "high"> = { normal: "low", slowed: "medium", stopped: "high" };

const clean = (s: string) => s.trim();

export function buildCommonPayload(v: TicketFormValues): Record<string, unknown> {
  const out: Record<string, unknown> = { type: v.type, subject: clean(v.subject), description: clean(v.description) };
  if (v.categoryId) out.categoryId = v.categoryId;
  if (clean(v.contactPhone)) out.contactPhone = clean(v.contactPhone);
  if (clean(v.locationNote)) out.locationNote = clean(v.locationNote);
  if (v.type === "incident") {
    out.impact = IMPACT_FOR[v.affectedPeople];
    out.urgency = URGENCY_FOR[v.workImpact];
    if (clean(v.affectedService)) out.typeDetails = { affectedService: clean(v.affectedService) };
  } else if (clean(v.requestedItem)) {
    out.typeDetails = { requestedItem: clean(v.requestedItem) };
  }
  return out;
}

/** Form B body: NO requester, creator, channel or role of any kind. */
export function buildSelfPayload(v: TicketFormValues, attachmentIds: string[] = []): Record<string, unknown> {
  const out = buildCommonPayload(v);
  if (attachmentIds.length > 0) out.attachmentIds = attachmentIds;
  return out;
}

export interface AgentFields {
  channel: "phone" | "walk_in" | "email" | "teams" | "chat";
  overrideEnabled: boolean;
  overridePriority: "p1" | "p2" | "p3" | "p4";
  overrideReason: string;
  assignmentGroupId: string;
  assigneeEmployeeId: string;
}

export const EMPTY_AGENT_FIELDS: AgentFields = {
  channel: "phone", overrideEnabled: false, overridePriority: "p3", overrideReason: "", assignmentGroupId: "", assigneeEmployeeId: "",
};

/** Form A body: only the requester's ID identifies them; name/email/department are re-read by the server. */
export function buildAssistedPayload(v: TicketFormValues, requesterEmployeeId: string, a: AgentFields, attachmentIds: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...buildCommonPayload(v), requesterEmployeeId, channel: a.channel };
  if (attachmentIds.length > 0) out.attachmentIds = attachmentIds;
  if (a.overrideEnabled) out.priorityOverride = { priority: a.overridePriority, reason: clean(a.overrideReason) };
  if (a.assignmentGroupId) out.assignmentGroupId = a.assignmentGroupId;
  if (a.assigneeEmployeeId) out.assigneeEmployeeId = a.assigneeEmployeeId;
  return out;
}
