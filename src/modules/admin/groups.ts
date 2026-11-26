import { z } from "zod";
import type { Actor } from "@/modules/identity/actor";
import { NotFoundError, UnprocessableError, ValidationError } from "@/platform/errors";
import { adminWrite, assertAdmin, diff, type AdminDeps } from "./shared";

// Update schemas are built from DEFAULT-FREE fields: Zod's .partial() keeps .default() values, which would make a PATCH of one field
// silently reset the others (e.g. deactivating a group would set its strategy back to "manual").
const groupFields = {
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  isTriage: z.boolean(),
  strategy: z.enum(["manual", "round_robin", "least_loaded"]),
};
export const GroupCreate = z.object({ ...groupFields, isTriage: groupFields.isTriage.default(false), strategy: groupFields.strategy.default("manual") }).strict();
export const GroupUpdate = z.object(groupFields).partial().extend({ active: z.boolean().optional() }).strict();
export const MemberAdd = z.object({ employeeId: z.string().uuid(), role: z.enum(["member", "lead"]).default("member") }).strict();

export async function listGroups(db: AdminDeps["db"], actor: Actor) {
  assertAdmin(actor);
  const groups = await db.assignmentGroup.findMany({
    orderBy: { name: "asc" },
    include: { members: { include: { employee: { select: { id: true, displayName: true, mail: true, accountEnabled: true } } }, orderBy: { addedAt: "asc" } } },
  });
  return groups.map((g) => ({
    id: g.id, name: g.name, description: g.description, email: g.email, isTriage: g.isTriage, strategy: g.strategy, active: g.active,
    members: g.members.map((m) => ({ employeeId: m.employeeId, displayName: m.employee.displayName, mail: m.employee.mail, role: m.role, available: m.employee.accountEnabled })),
  }));
}

export async function createGroup(deps: AdminDeps, actor: Actor, input: z.infer<typeof GroupCreate>, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "group.create", entityType: "assignment_group" }, async (tx) => {
    const g = await tx.assignmentGroup.create({ data: { ...input, description: input.description ?? null, email: input.email ?? null } });
    return { result: { id: g.id }, entityId: g.id, changes: { name: g.name, strategy: g.strategy, isTriage: g.isTriage } };
  }, "A group with that name already exists.", requestId);
}

export async function updateGroup(deps: AdminDeps, actor: Actor, id: string, input: z.infer<typeof GroupUpdate>, requestId?: string) {
  assertAdmin(actor);
  if (Object.keys(input).length === 0) throw new ValidationError("Nothing to change.");
  return adminWrite(deps, actor, { action: "group.update", entityType: "assignment_group" }, async (tx) => {
    const before = await tx.assignmentGroup.findUnique({ where: { id } });
    if (!before) throw new NotFoundError();
    const changes = diff(before as never, input as never);
    if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");
    await tx.assignmentGroup.update({ where: { id }, data: input });
    return { result: { id }, entityId: id, changes };
  }, "A group with that name already exists.", requestId);
}

export async function addMember(deps: AdminDeps, actor: Actor, groupId: string, input: z.infer<typeof MemberAdd>, requestId?: string) {
  assertAdmin(actor, "config.group_membership");
  return adminWrite(deps, actor, { action: "group.member_add", entityType: "assignment_group" }, async (tx) => {
    const g = await tx.assignmentGroup.findUnique({ where: { id: groupId }, select: { id: true } });
    if (!g) throw new NotFoundError();
    const e = await tx.employee.findUnique({ where: { id: input.employeeId } });
    if (!e || !e.isEligible || !e.accountEnabled || e.directoryDeletedAt) throw new UnprocessableError("EMPLOYEE_NOT_ELIGIBLE", "That person cannot be added to a group.");
    await tx.assignmentGroupMember.upsert({ where: { groupId_employeeId: { groupId, employeeId: input.employeeId } }, create: { groupId, employeeId: input.employeeId, role: input.role }, update: { role: input.role } });
    return { result: { groupId, employeeId: input.employeeId }, entityId: groupId, changes: { employeeId: input.employeeId, role: input.role } };
  }, "Could not add the member.", requestId);
}

export async function removeMember(deps: AdminDeps, actor: Actor, groupId: string, employeeId: string, requestId?: string) {
  assertAdmin(actor, "config.group_membership");
  return adminWrite(deps, actor, { action: "group.member_remove", entityType: "assignment_group" }, async (tx) => {
    const r = await tx.assignmentGroupMember.deleteMany({ where: { groupId, employeeId } });
    if (r.count === 0) throw new NotFoundError();
    return { result: { groupId, employeeId }, entityId: groupId, changes: { employeeId } };
  }, "Could not remove the member.", requestId);
}
