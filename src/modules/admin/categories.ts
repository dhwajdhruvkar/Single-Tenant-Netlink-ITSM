import { z } from "zod";
import type { Actor } from "@/modules/identity/actor";
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "@/platform/errors";
import { adminWrite, assertAdmin, diff, type AdminDeps } from "./shared";

const Level = z.enum(["low", "medium", "high"]);
// Default-free fields for updates (see groups.ts): .partial() would keep the defaults and a PATCH would wipe ticketTypes / sortOrder.
const categoryFields = {
  name: z.string().trim().min(1).max(100),
  parentId: z.string().uuid().nullable().optional(),
  ticketTypes: z.array(z.enum(["incident", "service_request"])).max(2), // empty = every type
  defaultGroupId: z.string().uuid().nullable().optional(),
  defaultImpact: Level.nullable().optional(),
  defaultUrgency: Level.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000),
};
export const CategoryCreate = z.object({ ...categoryFields, ticketTypes: categoryFields.ticketTypes.default([]), sortOrder: categoryFields.sortOrder.default(0) }).strict();
export const CategoryUpdate = z.object(categoryFields).partial().extend({ active: z.boolean().optional() }).strict();

export async function listCategories(db: AdminDeps["db"], actor: Actor) {
  assertAdmin(actor);
  return db.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, parentId: true, ticketTypes: true, defaultGroupId: true, defaultImpact: true, defaultUrgency: true, sortOrder: true, active: true } });
}

async function validateRefs(tx: Parameters<Parameters<typeof adminWrite>[3]>[0], id: string | null, input: { parentId?: string | null; defaultGroupId?: string | null; name?: string }) {
  if (input.defaultGroupId) {
    const g = await tx.assignmentGroup.findFirst({ where: { id: input.defaultGroupId, active: true }, select: { id: true } });
    if (!g) throw new UnprocessableError("GROUP_INVALID", "The default group is not available.");
  }
  if (input.parentId) {
    if (input.parentId === id) throw new UnprocessableError("CATEGORY_CYCLE", "A category cannot be its own parent.");
    // walk up from the proposed parent; meeting `id` would make a cycle
    let cursor: string | null = input.parentId;
    for (let depth = 0; cursor && depth < 20; depth++) {
      if (cursor === id) throw new UnprocessableError("CATEGORY_CYCLE", "That would make the category its own ancestor.");
      const parent: { parentId: string | null } | null = await tx.category.findUnique({ where: { id: cursor }, select: { parentId: true } });
      if (!parent) throw new UnprocessableError("CATEGORY_INVALID", "The parent category does not exist.");
      cursor = parent.parentId;
    }
  }
}

export async function createCategory(deps: AdminDeps, actor: Actor, input: z.infer<typeof CategoryCreate>, requestId?: string) {
  assertAdmin(actor);
  return adminWrite(deps, actor, { action: "category.create", entityType: "category" }, async (tx) => {
    await validateRefs(tx, null, input);
    // (parentId, name) is unique in the schema, but NULLs are distinct in Postgres, so top-level names are checked here.
    const clash = await tx.category.findFirst({ where: { name: input.name, parentId: input.parentId ?? null }, select: { id: true } });
    if (clash) throw new ConflictError("A category with that name already exists here.");
    const c = await tx.category.create({ data: { ...input, parentId: input.parentId ?? null, defaultGroupId: input.defaultGroupId ?? null, defaultImpact: input.defaultImpact ?? null, defaultUrgency: input.defaultUrgency ?? null } });
    return { result: { id: c.id }, entityId: c.id, changes: { name: c.name } };
  }, "A category with that name already exists here.", requestId);
}

export async function updateCategory(deps: AdminDeps, actor: Actor, id: string, input: z.infer<typeof CategoryUpdate>, requestId?: string) {
  assertAdmin(actor);
  if (Object.keys(input).length === 0) throw new ValidationError("Nothing to change.");
  return adminWrite(deps, actor, { action: "category.update", entityType: "category" }, async (tx) => {
    const before = await tx.category.findUnique({ where: { id } });
    if (!before) throw new NotFoundError();
    await validateRefs(tx, id, input);
    const name = input.name ?? before.name;
    const parentId = input.parentId !== undefined ? input.parentId : before.parentId;
    if (input.name !== undefined || input.parentId !== undefined) {
      const clash = await tx.category.findFirst({ where: { name, parentId, NOT: { id } }, select: { id: true } });
      if (clash) throw new ConflictError("A category with that name already exists here.");
    }
    const changes = diff(before as never, input as never);
    if (Object.keys(changes).length === 0) throw new ValidationError("Nothing to change.");
    await tx.category.update({ where: { id }, data: input });
    return { result: { id }, entityId: id, changes };
  }, "A category with that name already exists here.", requestId);
}
