import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { Card, PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/admin");
  if (!can(actor.role, "config.manage")) return <Forbidden />;
  return (
    <AppShell>
      <PageHeader title="Administration" />
      <Card>
        <ul className="space-y-2 text-sm">
          <li><Link className="text-blue-700 underline" href="/admin/groups">Assignment groups and members</Link></li>
          <li><Link className="text-blue-700 underline" href="/admin/categories">Categories</Link></li>
          <li><Link className="text-blue-700 underline" href="/admin/sla">SLA policies and calendars</Link></li>
        </ul>
      </Card>
    </AppShell>
  );
}
