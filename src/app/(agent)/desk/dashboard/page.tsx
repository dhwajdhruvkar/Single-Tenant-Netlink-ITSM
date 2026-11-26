import { redirect } from "next/navigation";
import { can } from "@/modules/identity/permissions";
import { getPageActor } from "@/platform/http/pageActor";
import { AppShell } from "@/ui/AppShell";
import { Forbidden } from "@/ui/Forbidden";
import { PageHeader } from "@/ui/primitives";
import { ReportsView } from "@/ui/reports/ReportsView";
import { loadReportPage } from "@/ui/reports/reportPage";

export const dynamic = "force-dynamic";

export default async function DeskDashboard({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await getPageActor();
  if (!actor) redirect("/signin?callbackUrl=/desk/dashboard");
  if (!can(actor.role, "reports.team")) return <Forbidden />;
  const data = await loadReportPage(actor, await searchParams);
  return (
    <AppShell>
      <PageHeader title="Dashboard" description="Your team's workload and service levels." />
      {"error" in data ? <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{data.error}</p>
        : <ReportsView summary={data.summary} groups={data.groups} basePath="/desk/dashboard" canExport={can(actor.role, "reports.all")} from={data.from} to={data.to} />}
    </AppShell>
  );
}
