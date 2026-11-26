import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";
import type { AppRole } from "@/modules/identity/roleMapping";
import { allocateTicketNumber, formatReference } from "@/modules/tickets/reference";

// Test world builder shared by the lifecycle integration tests.
export function world(prisma: PrismaClient) {
  let n = 0;
  const person = (over: Record<string, unknown> = {}) =>
    prisma.employee.create({ data: { entraObjectId: randomUUID(), userPrincipalName: `w${++n}@example.test`, mail: `w${n}@example.test`, displayName: `Person ${n}`, ...over } });

  async function actor(role: AppRole, groups: { id: string; isTriage?: boolean }[] = [], over: Record<string, unknown> = {}): Promise<Actor> {
    const e = await person(over);
    const a = await prisma.userAccount.create({ data: { employeeId: e.id, role } });
    for (const g of groups) await prisma.assignmentGroupMember.create({ data: { groupId: g.id, employeeId: e.id } });
    return { employeeId: e.id, userAccountId: a.id, role, groupIds: groups.map((g) => g.id), triageGroupIds: groups.filter((g) => g.isTriage).map((g) => g.id) };
  }

  const group = (name: string, isTriage = false) => prisma.assignmentGroup.create({ data: { name, isTriage } });

  async function ticket(f: {
    requester: Actor; createdBy?: Actor; group?: string | null; assignee?: Actor | null; status?: string; holdReason?: string | null;
    priority?: "p1" | "p2" | "p3" | "p4"; subject?: string; description?: string; type?: "incident" | "service_request"; createdAt?: Date;
    resolvedAt?: Date | null; responseDueAt?: Date | null; resolveDueAt?: Date | null; slaPausedAt?: Date | null; categoryId?: string | null;
  }) {
    const number = await allocateTicketNumber(prisma);
    return prisma.ticket.create({
      data: {
        number, reference: formatReference(f.type ?? "incident", number), type: f.type ?? "incident", channel: "portal",
        status: (f.status ?? "new") as never, holdReason: (f.holdReason ?? null) as never, subject: f.subject ?? "A problem", description: f.description ?? "Details",
        impact: "medium", urgency: "medium", priority: f.priority ?? "p3", requesterName: "Requester",
        requesterEmployeeId: f.requester.employeeId, createdByEmployeeId: (f.createdBy ?? f.requester).employeeId,
        assignmentGroupId: f.group ?? null, assigneeEmployeeId: f.assignee?.employeeId ?? null, categoryId: f.categoryId ?? null,
        createdAt: f.createdAt, resolvedAt: f.resolvedAt ?? null, responseDueAt: f.responseDueAt ?? null, resolveDueAt: f.resolveDueAt ?? null, slaPausedAt: f.slaPausedAt ?? null,
      },
    });
  }
  return { person, actor, group, ticket };
}
