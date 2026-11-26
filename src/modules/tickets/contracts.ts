import { z } from "zod";

// HTTP contracts. `.strict()` makes unknown keys a 400, so the self-service form can never smuggle in a requester,
// snapshot field or role: identity comes only from the server-side session.

const Common = z
  .object({
    type: z.enum(["incident", "service_request"]),
    categoryId: z.string().uuid().optional(),
    subject: z.string().trim().min(3).max(200),
    description: z.string().trim().min(1).max(20000),
    impact: z.enum(["low", "medium", "high"]).optional(),
    urgency: z.enum(["low", "medium", "high"]).optional(),
    contactPhone: z.string().trim().max(40).optional(),
    locationNote: z.string().trim().max(160).optional(),
    typeDetails: z.unknown().optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict();

export const SelfServiceCreate = Common;

export const AssistedCreate = Common.extend({
  requesterEmployeeId: z.string().uuid(),
  channel: z.enum(["phone", "walk_in", "email", "teams", "chat"]),
  priorityOverride: z.object({ priority: z.enum(["p1", "p2", "p3", "p4"]), reason: z.string().trim().min(3).max(500) }).strict().optional(),
  assignmentGroupId: z.string().uuid().optional(),
  assigneeEmployeeId: z.string().uuid().optional(),
}).strict();

export type SelfServiceCreateInput = z.infer<typeof SelfServiceCreate>;
export type AssistedCreateInput = z.infer<typeof AssistedCreate>;

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
