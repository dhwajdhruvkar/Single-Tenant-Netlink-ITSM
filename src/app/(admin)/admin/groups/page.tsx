import { redirect } from "next/navigation";
import { listGroups } from "@/modules/admin/groups";
import { can } from "@/modules/identity/permissions";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { GroupsAdmin } from "@/ui/admin/GroupsAdmin";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/admin/groups");
  if (!can(actor.role, "config.manage")) return <Forbidden />;
  return <AppShell><PageHeader title="Assignment groups" description="Members must be agents to take tickets. A triage group sees tickets that have no group yet." /><GroupsAdmin groups={await listGroups(prisma, actor)} /></AppShell>;
}
