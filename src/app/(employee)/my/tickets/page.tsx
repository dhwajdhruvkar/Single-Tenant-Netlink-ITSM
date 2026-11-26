import Link from "next/link";
import { redirect } from "next/navigation";
import { listMyTickets } from "@/modules/tickets/queries";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Card, PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

// Minimal "my tickets" list; filters, paging and live refresh arrive in Phase 7.
export default async function MyTicketsPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/my/tickets");
  const tickets = await listMyTickets(prisma, actor);

  return (
    <AppShell>
      <PageHeader title="My tickets" />
      <p className="mb-4"><Link href="/my/tickets/new" className="text-sm text-blue-700 underline">Create a new ticket</Link></p>
      <Card>
        {tickets.length === 0 ? (
          <p className="text-sm text-gray-600">You have no tickets yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tickets.map((t) => (
              <li key={t.id} className="py-2 text-sm">
                <Link href={`/my/tickets/${t.reference}`} className="font-medium text-blue-700 underline">{t.reference}</Link> {t.subject}
                <span className="ml-2 text-gray-500">{t.status} · {t.priority.toUpperCase()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
