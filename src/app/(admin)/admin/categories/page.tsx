import { redirect } from "next/navigation";
import { listCategories } from "@/modules/admin/categories";
import { can } from "@/modules/identity/permissions";
import { prisma } from "@/platform/db/prisma";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { CategoriesAdmin } from "@/ui/admin/CategoriesAdmin";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/admin/categories");
  if (!can(actor.role, "config.manage")) return <Forbidden />;
  const [categories, groups] = await Promise.all([listCategories(prisma, actor), prisma.assignmentGroup.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } })]);
  return <AppShell><PageHeader title="Categories" /><CategoriesAdmin categories={categories} groups={groups} /></AppShell>;
}
