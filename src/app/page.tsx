import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Card, PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

// Role-aware entry points. Hiding a link is cosmetic: every page and API enforces the role again on the server.
export default async function HomePage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin");
  const links = [
    { href: "/my/tickets/new", label: "Report a problem or request something" },
    { href: "/my/tickets", label: "My tickets" },
    ...(can(actor.role, "ticket.view.queue") ? [{ href: "/desk", label: "Service desk queues" }] : []),
    ...(can(actor.role, "config.manage") ? [{ href: "/admin", label: "Administration" }] : []),
    ...(can(actor.role, "ticket.create.assisted") ? [{ href: "/desk/tickets/new", label: "Log a ticket for an employee" }] : []),
  ];
  return (
    <AppShell>
      <PageHeader title="Netlink ITSM" />
      <Card>
        <ul className="space-y-2 text-sm">
          {links.map((l) => (
            <li key={l.href}><Link href={l.href} className="text-blue-700 underline">{l.label}</Link></li>
          ))}
        </ul>
      </Card>
    </AppShell>
  );
}
