import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import { canViewTicket, type TicketAccessFacts } from "@/modules/identity/policies";
import type { AppRole } from "@/modules/identity/roleMapping";
import { visibleTicketsWhere } from "@/modules/tickets/access";
import { allocateTicketNumber, formatReference } from "@/modules/tickets/reference";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

let n = 0;
const person = () => prisma.employee.create({ data: { entraObjectId: randomUUID(), userPrincipalName: `a${++n}@example.test`, displayName: `P${n}` } });

// The SQL predicate used by lists must agree with the in-memory policy used for single records, for every role and relationship.
describe("visibleTicketsWhere parity with canViewTicket", () => {
  const ROLES: AppRole[] = ["employee", "submitter", "agent", "manager", "admin"];

  it.each([false, true])("matches for every role x relationship (agentsViewAllTickets=%s)", async (agentsViewAllTickets) => {
    const me = await person();
    const other = await person();
    const [gMine, gOther, gTriage] = await Promise.all(
      ["Mine", "Other", "Triage"].map((name) => prisma.assignmentGroup.create({ data: { name: `${name}${agentsViewAllTickets}`, isTriage: name === "Triage" } })),
    );
    const mk = async (label: string, f: { requester: string; createdBy: string; assignee?: string | null; group?: string | null; archived?: boolean }) => {
      const number = await allocateTicketNumber(prisma);
      return prisma.ticket.create({
        data: {
          number, reference: formatReference("incident", number), type: "incident", channel: "portal", subject: label, description: "d",
          impact: "medium", urgency: "medium", priority: "p3", requesterName: "r",
          requesterEmployeeId: f.requester, createdByEmployeeId: f.createdBy, assigneeEmployeeId: f.assignee ?? null, assignmentGroupId: f.group ?? null,
          archivedAt: f.archived ? new Date() : null,
        },
      });
    };
    await mk("requester-me", { requester: me.id, createdBy: me.id });
    await mk("created-by-me", { requester: other.id, createdBy: me.id });
    await mk("assigned-to-me", { requester: other.id, createdBy: other.id, assignee: me.id, group: gOther.id });
    await mk("my-group", { requester: other.id, createdBy: other.id, group: gMine.id });
    await mk("other-group", { requester: other.id, createdBy: other.id, group: gOther.id });
    await mk("no-group", { requester: other.id, createdBy: other.id, group: null });
    await mk("archived-mine", { requester: me.id, createdBy: me.id, archived: true });

    const options = { agentsViewAllTickets };
    for (const role of ROLES) {
      for (const inTriage of [false, true]) {
        const actor: Actor = {
          employeeId: me.id, userAccountId: "ua", role,
          groupIds: role === "employee" || role === "submitter" ? [] : inTriage ? [gMine.id, gTriage.id] : [gMine.id],
          triageGroupIds: role === "employee" || role === "submitter" ? [] : inTriage ? [gTriage.id] : [],
        };
        const all = await prisma.ticket.findMany({ where: { archivedAt: null } });
        const expected = all.filter((t) => canViewTicket(actor, t as TicketAccessFacts, options)).map((t) => t.subject).sort();
        const actual = (await prisma.ticket.findMany({ where: visibleTicketsWhere(actor, options) })).map((t) => t.subject).sort();
        expect(actual, `${role} triage=${inTriage}`).toEqual(expected);
      }
    }
  });

  it("never returns archived tickets, even to managers", async () => {
    const me = await person();
    const number = await allocateTicketNumber(prisma);
    await prisma.ticket.create({ data: { number, reference: formatReference("incident", number), type: "incident", channel: "portal", subject: "gone", description: "d", impact: "low", urgency: "low", priority: "p4", requesterName: "r", requesterEmployeeId: me.id, createdByEmployeeId: me.id, archivedAt: new Date() } });
    const actor: Actor = { employeeId: me.id, userAccountId: "ua", role: "admin", groupIds: [], triageGroupIds: [] };
    expect(await prisma.ticket.count({ where: visibleTicketsWhere(actor) })).toBe(0);
  });
});
