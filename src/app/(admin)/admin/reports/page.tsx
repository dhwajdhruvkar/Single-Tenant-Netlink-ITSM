import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";
import { ReportsView } from "@/ui/reports/ReportsView";
import { loadReportPage } from "@/ui/reports/reportPage";

export const dynamic = "force-dynamic";

export default async function AdminReports({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/admin/reports");
  if (!can(actor.role, "reports.all")) return <Forbidden />;
  const data = await loadReportPage(actor, await searchParams);
  return (
    <AppShell>
      <PageHeader title="Reports" description="Service levels and workload across all tickets." />
      {"error" in data ? <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{data.error}</p>
        : <ReportsView summary={data.summary} groups={data.groups} basePath="/admin/reports" canExport from={data.from} to={data.to} />}
    </AppShell>
  );
}
