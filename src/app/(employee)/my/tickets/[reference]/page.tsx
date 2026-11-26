import { notFound, redirect } from "next/navigation";
import { getTicketDetail } from "@/modules/tickets/detail";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { attachmentsUiConfig } from "@/platform/storage";
import { AppShell } from "@/ui/AppShell";
import { MessageComposer } from "@/ui/tickets/MessageComposer";
import { RequesterActions } from "@/ui/tickets/RequesterActions";
import { TicketDetailView } from "@/ui/tickets/TicketDetailView";
import { LivePoller } from "@/ui/tickets/useLivePolling";

export const dynamic = "force-dynamic";

export default async function MyTicketPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ created?: string }> }) {
  const { reference } = await params;
  const { created } = await searchParams;
  const actor = await getPageActor();
  if (!actor) redirect(`/signin?callbackUrl=/my/tickets/${encodeURIComponent(reference)}`);
  const ticket = await getTicketDetail(prisma, actor, reference.toUpperCase(), { policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } });
  if (!ticket) notFound(); // a ticket the viewer may not see is indistinguishable from one that does not exist

  return (
    <AppShell>
      <LivePoller />
      <TicketDetailView ticket={ticket} created={created === "1"} />
      <RequesterActions reference={ticket.reference} version={ticket.version} statuses={ticket.actions.statuses} />
      {ticket.actions.canReply ? <MessageComposer reference={ticket.reference} version={ticket.version} canNote={false} attachments={attachmentsUiConfig()} /> : <p className="mt-4 text-sm text-gray-500">This ticket is closed. Open a new ticket if you still need help.</p>}
    </AppShell>
  );
}
