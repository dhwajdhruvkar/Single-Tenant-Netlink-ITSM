import { redirect } from "next/navigation";
import { listSla } from "@/modules/admin/sla";
import { can } from "@/modules/identity/permissions";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { SlaAdmin } from "@/ui/admin/SlaAdmin";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function SlaPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/admin/sla");
  if (!can(actor.role, "config.manage")) return <Forbidden />;
  const { policies, calendars } = await listSla(prisma, actor);
  return <AppShell><PageHeader title="SLA policies and calendars" /><SlaAdmin policies={policies} calendars={calendars} /></AppShell>;
}
