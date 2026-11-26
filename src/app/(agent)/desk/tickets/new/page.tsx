import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { atLeast } from "@/modules/identity/roleMapping";
import { listCategoriesFor, listGroupsWithMembers } from "@/modules/tickets/queries";
import { prisma } from "@/platform/db/prisma";
import { attachmentsUiConfig } from "@/platform/storage";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";
import { AssistedTicketForm } from "@/ui/tickets/AssistedTicketForm";

export const dynamic = "force-dynamic";

// Form A. Server-side role check: an employee-role user gets the Forbidden page, and the API returns 403 independently.
export default async function AssistedNewTicketPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/desk/tickets/new");
  if (!can(actor.role, "ticket.create.assisted")) return <Forbidden />;

  const agent = atLeast(actor.role, "agent");
  const [incident, request, groups, me] = await Promise.all([
    listCategoriesFor(prisma, "incident"),
    listCategoriesFor(prisma, "service_request"),
    agent ? listGroupsWithMembers(prisma) : Promise.resolve([]),
    prisma.employee.findUnique({ where: { id: actor.employeeId }, select: { displayName: true } }),
  ]);
  const categories = [...new Map([...incident, ...request].map((c) => [c.id, c])).values()];

  const attachments = attachmentsUiConfig();
  return (
    <AppShell>
      <PageHeader title="Log a ticket for an employee" description="Find the person, then describe their issue." />
      <div className="max-w-2xl">
        <AssistedTicketForm agentName={me?.displayName ?? "You"} categories={categories} groups={groups} canOverride={agent} loadRecent={loadRecent} attachments={attachments} />
      </div>
    </AppShell>
  );
}

// Client-side helper used by the form to fetch the last tickets for the chosen requester (visible to this agent only).
async function loadRecent(employeeId: string) {
  "use server";
  const actor = await getPageActor();
  if (!actor || !can(actor.role, "ticket.view.queue")) return [];
  const { listRecentForRequester } = await import("@/modules/tickets/queries");
  const rows = await listRecentForRequester(prisma, actor, employeeId, 5);
  return rows.map((r) => ({ id: r.id, reference: r.reference, subject: r.subject, status: r.status }));
}
