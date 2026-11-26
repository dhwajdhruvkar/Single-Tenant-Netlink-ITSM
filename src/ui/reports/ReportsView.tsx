import type { ReportSummary } from "@/modules/reporting/queries";
import { Card } from "@/ui/primitives";
import { BarList, StatTile, TrendChart } from "./Charts";
import { formatMinutes, formatPct } from "./format";

const label = (s: string) => s.replace("_", " ").replace(/^./, (c) => c.toUpperCase());

export interface ReportsViewProps {
  summary: ReportSummary;
  groups: { id: string; name: string }[];
  basePath: string;
  /** Show the CSV export link (managers and admins only). */
  canExport: boolean;
  /** The inclusive dates the person asked for, for the form. */
  from: string;
  to: string;
}

export function ReportsView({ summary: s, groups, basePath, canExport, from, to }: ReportsViewProps) {
  const exportQuery = new URLSearchParams({ from, to, ...(s.groupId ? { groupId: s.groupId } : {}) }).toString();
  return (
    <div className="space-y-4">
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2" role="search" aria-label="Report period">
        <div><label htmlFor="r-from" className="block text-xs text-gray-600">From</label><input id="r-from" type="date" name="from" defaultValue={from} className="rounded-md border border-gray-300 px-2 py-1 text-sm" /></div>
        <div><label htmlFor="r-to" className="block text-xs text-gray-600">To (inclusive)</label><input id="r-to" type="date" name="to" defaultValue={to} className="rounded-md border border-gray-300 px-2 py-1 text-sm" /></div>
        <div><label htmlFor="r-group" className="block text-xs text-gray-600">Group</label>
          <select id="r-group" name="groupId" defaultValue={s.groupId ?? ""} className="rounded-md border border-gray-300 px-2 py-1 text-sm"><option value="">{s.scope === "all" ? "All groups" : "All my groups"}</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
        <button type="submit" className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Apply</button>
        {canExport ? <a href={`/api/reports/export.csv?${exportQuery}`} className="rounded-md border border-gray-300 px-3 py-1 text-sm text-blue-700 hover:bg-gray-50">Download CSV</a> : null}
      </form>
      <p className="text-xs text-gray-600">
        {s.scope === "all" ? "All tickets" : "Tickets assigned to you or your groups"} · created {from} to {to} (UTC days, inclusive) · generated {s.generatedAt.slice(0, 16).replace("T", " ")} UTC
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Open now" value={s.openTotal} hint={s.oldestOpenDays === null ? undefined : `oldest ${s.oldestOpenDays} d`} />
        <StatTile label="Past SLA, still open" value={s.sla.breachedOpen} tone={s.sla.breachedOpen > 0 ? "bad" : "plain"} hint="paused tickets excluded" />
        <StatTile label="Created in period" value={s.createdTotal} />
        <StatTile label="Resolved in period" value={s.resolvedTotal} />
        <StatTile label="Median time to resolve" value={formatMinutes(s.resolveTime.medianMinutes)} hint={`average ${formatMinutes(s.resolveTime.avgMinutes)} · ${s.resolveTime.count} tickets`} />
        <StatTile label="Median first response" value={formatMinutes(s.firstResponse.medianMinutes)} hint={`average ${formatMinutes(s.firstResponse.avgMinutes)} · ${s.firstResponse.count} tickets`} />
        <StatTile label="Resolution SLA met" value={formatPct(s.sla.resolve.pct)} hint={`${s.sla.resolve.met} of ${s.sla.resolve.total}`} />
        <StatTile label="Response SLA met" value={formatPct(s.sla.response.pct)} hint={`${s.sla.response.met} of ${s.sla.response.total}`} />
      </div>

      <Card><TrendChart title="Created vs resolved per day" points={s.createdVsResolved} /></Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card><BarList title="Open by status" rows={s.openByStatus.map((r) => ({ label: label(r.status), value: r.count }))} empty="No open tickets." /></Card>
        <Card><BarList title="Open by priority" rows={s.openByPriority.map((r) => ({ label: r.priority.toUpperCase(), value: r.count }))} empty="No open tickets." /></Card>
        <Card><BarList title="Open by group" rows={s.openByGroup.map((r) => ({ label: r.name, value: r.count }))} empty="No open tickets." /></Card>
        <Card><BarList title="Age of open tickets" rows={s.backlogAge.map((r) => ({ label: r.bucket, value: r.count }))} empty="No open tickets." /></Card>
      </div>

      <Card>
        <h2 className="mb-2 text-sm font-medium text-gray-900">Resolved by agent</h2>
        {s.perAgent.length === 0 ? <p className="text-sm text-gray-600">No tickets were resolved in this period.</p> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="text-xs text-gray-600"><th scope="col" className="py-1">Agent</th><th scope="col">Resolved</th><th scope="col">Median time to resolve</th></tr></thead>
            <tbody>{s.perAgent.map((a) => <tr key={a.employeeId} className="border-t border-gray-100"><th scope="row" className="py-1.5 font-normal">{a.name}</th><td className="tabular-nums">{a.resolved}</td><td>{formatMinutes(a.medianMinutes)}</td></tr>)}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
