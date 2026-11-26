import { notFound, redirect } from "next/navigation";
import { getTicketSummaryForViewer } from "@/modules/tickets/queries";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { TicketSummaryView } from "@/ui/tickets/TicketSummaryView";

export const dynamic = "force-dynamic";

export default async function MyTicketPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ created?: string }> }) {
  const { reference } = await params;
  const { created } = await searchParams;
  const actor = await getPageActor();
  if (!actor) redirect(`/signin?callbackUrl=/my/tickets/${encodeURIComponent(reference)}`);
  const ticket = await getTicketSummaryForViewer(prisma, actor, reference, { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS });
  if (!ticket) notFound(); // a ticket the viewer may not see is indistinguishable from one that does not exist
  return (
    <AppShell>
      <TicketSummaryView ticket={ticket} created={created === "1"} />
    </AppShell>
  );
}
