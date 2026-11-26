import Link from "next/link";
import { redirect } from "next/navigation";
import { mySummary } from "@/modules/reporting/queries";
import { listTickets } from "@/modules/tickets/list";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Card, PageHeader } from "@/ui/primitives";
import { Pager, TicketTable } from "@/ui/tickets/TicketTable";
import { LivePoller } from "@/ui/tickets/useLivePolling";

export const dynamic = "force-dynamic";
const STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];

export default async function MyTicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/my/tickets");
  const sp = await searchParams;
  const summary = await mySummary(prisma, actor);
  const page = Math.max(1, Number(sp.page) || 1);
  const result = await listTickets(prisma, actor, {
    view: "mine", page, pageSize: 25, sortBy: "createdAt", sortDir: "desc",
    status: sp.status && STATUSES.includes(sp.status) ? [sp.status] : undefined, q: sp.q?.slice(0, 100),
  }, { policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } });
  const href = (p: number) => { const q = new URLSearchParams(); if (sp.status) q.set("status", sp.status); if (sp.q) q.set("q", sp.q); q.set("page", String(p)); return `/my/tickets?${q}`; };

  return (
    <AppShell>
      <LivePoller />
      <PageHeader title="My tickets" />
      <dl className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Your tickets at a glance">
        {[["Open", summary.open], ["Waiting for your reply", summary.awaitingMyReply], ["Resolved, please confirm", summary.resolvedToConfirm], ["Closed in the last 30 days", summary.closedLast30Days]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">{k}</dt><dd className="text-xl font-semibold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      <p className="mb-3"><Link href="/my/tickets/new" className="text-sm text-blue-700 underline">Create a new ticket</Link></p>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2" role="search">
        <div><label htmlFor="m-q" className="block text-xs text-gray-600">Search</label><input id="m-q" name="q" defaultValue={sp.q ?? ""} maxLength={100} className="rounded-md border border-gray-300 px-2 py-1 text-sm" /></div>
        <div><label htmlFor="m-status" className="block text-xs text-gray-600">Status</label>
          <select id="m-status" name="status" defaultValue={sp.status ?? ""} className="rounded-md border border-gray-300 px-2 py-1 text-sm"><option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
        <button type="submit" className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Apply</button>
      </form>
      <Card><TicketTable rows={result.data} basePath="/my/tickets" showQueue={false} /></Card>
      <Pager page={result.meta.page} totalPages={result.meta.totalPages} hrefFor={href} />
    </AppShell>
  );
}
