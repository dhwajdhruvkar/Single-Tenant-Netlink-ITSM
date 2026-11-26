import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { listTickets, SORTABLE, VIEWS, type View } from "@/modules/tickets/list";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { Card, PageHeader } from "@/ui/primitives";
import { Pager, TicketTable } from "@/ui/tickets/TicketTable";
import { LivePoller } from "@/ui/tickets/useLivePolling";

export const dynamic = "force-dynamic";

const TABS: { view: View; label: string; needs?: "view.all" }[] = [
  { view: "assigned", label: "My tickets" },
  { view: "groups", label: "My groups" },
  { view: "unassigned", label: "Unassigned (triage)" },
  { view: "breaching", label: "Breaching soon" },
  { view: "all", label: "All tickets", needs: "view.all" },
];
const STATUSES = ["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];

export default async function DeskPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/desk");
  const policy = { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS };
  if (!can(actor.role, "ticket.view.queue", policy)) return <Forbidden />;

  const sp = await searchParams;
  const tabs = TABS.filter((t) => !t.needs || can(actor.role, "ticket.view.all", policy));
  const requested = (VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as View) : "assigned";
  const view = tabs.some((t) => t.view === requested) ? requested : "assigned";
  const page = Math.max(1, Number(sp.page) || 1);
  const sortBy = (SORTABLE as readonly string[]).includes(sp.sortBy ?? "") ? (sp.sortBy as (typeof SORTABLE)[number]) : "createdAt";

  const result = await listTickets(prisma, actor, {
    view, page, pageSize: 25, sortBy, sortDir: sp.sortDir === "asc" ? "asc" : "desc",
    status: sp.status && STATUSES.includes(sp.status) ? [sp.status] : undefined,
    priority: sp.priority && ["p1", "p2", "p3", "p4"].includes(sp.priority) ? [sp.priority] : undefined,
    q: sp.q?.slice(0, 100),
  }, { policy });

  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const all: Record<string, string | number | undefined> = { ...sp, view, ...over };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/desk?${p.toString()}`;
  };

  return (
    <AppShell>
      <LivePoller />
      <PageHeader title="Service desk" />
      <p className="mb-3 flex gap-4 text-sm"><Link href="/desk/tickets/new" className="text-blue-700 underline">Log a ticket for an employee</Link><Link href="/desk/dashboard" className="text-blue-700 underline">Dashboard</Link></p>
      <nav aria-label="Queues" className="mb-3 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link key={t.view} href={href({ view: t.view, page: 1 })} aria-current={t.view === view ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${t.view === view ? "border-blue-700 bg-blue-700 text-white" : "border-gray-300 bg-white text-gray-800 hover:bg-gray-50"}`}>{t.label}</Link>
        ))}
      </nav>
      <form method="get" className="mb-3 flex flex-wrap items-end gap-2" role="search">
        <input type="hidden" name="view" value={view} />
        <div><label htmlFor="f-q" className="block text-xs text-gray-600">Search</label><input id="f-q" name="q" defaultValue={sp.q ?? ""} maxLength={100} className="rounded-md border border-gray-300 px-2 py-1 text-sm" placeholder="Reference or words" /></div>
        <div><label htmlFor="f-status" className="block text-xs text-gray-600">Status</label>
          <select id="f-status" name="status" defaultValue={sp.status ?? ""} className="rounded-md border border-gray-300 px-2 py-1 text-sm"><option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
        <div><label htmlFor="f-priority" className="block text-xs text-gray-600">Priority</label>
          <select id="f-priority" name="priority" defaultValue={sp.priority ?? ""} className="rounded-md border border-gray-300 px-2 py-1 text-sm"><option value="">Any</option>{["p1", "p2", "p3", "p4"].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select></div>
        <div><label htmlFor="f-sort" className="block text-xs text-gray-600">Sort</label>
          <select id="f-sort" name="sortBy" defaultValue={sortBy} className="rounded-md border border-gray-300 px-2 py-1 text-sm"><option value="createdAt">Newest</option><option value="priority">Priority</option><option value="resolveDueAt">Resolution due</option><option value="updatedAt">Last updated</option></select></div>
        <button type="submit" className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Apply</button>
      </form>
      <Card><TicketTable rows={result.data} basePath="/desk/tickets" showQueue /></Card>
      <p className="mt-2 text-xs text-gray-500">{result.meta.total} ticket{result.meta.total === 1 ? "" : "s"}</p>
      <Pager page={result.meta.page} totalPages={result.meta.totalPages} hrefFor={(p) => href({ page: p })} />
    </AppShell>
  );
}
