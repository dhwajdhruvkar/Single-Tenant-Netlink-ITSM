import { notFound, redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { getTicketDetail } from "@/modules/tickets/detail";
import { listGroupsWithMembers } from "@/modules/tickets/queries";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { attachmentsUiConfig } from "@/platform/storage";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { AgentActions } from "@/ui/tickets/AgentActions";
import { MessageComposer } from "@/ui/tickets/MessageComposer";
import { TicketDetailView } from "@/ui/tickets/TicketDetailView";
import { LivePoller } from "@/ui/tickets/useLivePolling";

export const dynamic = "force-dynamic";

export default async function DeskTicketPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ created?: string }> }) {
  const { reference } = await params;
  const { created } = await searchParams;
  const actor = await getPageActor();
  if (!actor) redirect(`/signin?callbackUrl=/desk/tickets/${encodeURIComponent(reference)}`);
  const policy = { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS };
  if (!can(actor.role, "ticket.view.queue", policy)) return <Forbidden />;

  const ticket = await getTicketDetail(prisma, actor, reference.toUpperCase(), { policy });
  if (!ticket) notFound();
  const groups = ticket.actions.canAssign ? await listGroupsWithMembers(prisma) : [];

  return (
    <AppShell>
      <LivePoller />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          <TicketDetailView ticket={ticket} created={created === "1"} />
          {ticket.actions.canReply ? <MessageComposer reference={ticket.reference} version={ticket.version} canNote={ticket.actions.canNote} attachments={attachmentsUiConfig()} /> : <p className="mt-4 text-sm text-gray-500">This ticket is closed.</p>}
        </div>
        <aside>
          <AgentActions
            reference={ticket.reference} version={ticket.version} me={actor.employeeId} statuses={ticket.actions.statuses} canAssign={ticket.actions.canAssign}
            canEdit={ticket.actions.canEdit} canArchive={ticket.actions.canArchive} groups={groups}
            current={{ groupId: ticket.assignmentGroup?.id ?? null, assigneeId: ticket.assignee?.id ?? null, priority: ticket.priority, impact: ticket.impact, urgency: ticket.urgency, priorityOverridden: ticket.priorityOverridden }}
          />
        </aside>
      </div>
    </AppShell>
  );
}
