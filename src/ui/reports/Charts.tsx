import type { ReactNode } from "react";

// Dependency-free SVG/HTML charts. They render on the server, scale with their container, and always come with a text alternative
// (a visible table or labelled values), so no information is carried by colour alone.

const nf = new Intl.NumberFormat("en-GB");

export function StatTile({ label, value, hint, tone = "plain" }: { label: string; value: ReactNode; hint?: string; tone?: "plain" | "bad" }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === "bad" ? "text-red-700" : "text-gray-900"}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-gray-600">{hint}</div> : null}
    </div>
  );
}

/** Horizontal bars with the count printed beside each bar. */
export function BarList({ title, rows, empty = "Nothing to show." }: { title: string; rows: { label: string; value: number }[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure aria-label={title}>
      <figcaption className="mb-2 text-sm font-medium text-gray-900">{title}</figcaption>
      {rows.length === 0 || rows.every((r) => r.value === 0) ? <p className="text-sm text-gray-600">{empty}</p> : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-sm">
              <span className="truncate text-gray-800" title={r.label}>{r.label}</span>
              <span className="h-3 rounded bg-gray-100" aria-hidden="true"><span className="block h-3 rounded bg-blue-700" style={{ width: `${(r.value / max) * 100}%` }} /></span>
              <span className="text-right tabular-nums text-gray-900">{nf.format(r.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Created vs resolved per day: two polylines on a shared scale, with a data table for assistive tech and exact values. */
export function TrendChart({ title, points }: { title: string; points: { day: string; created: number; resolved: number }[] }) {
  const W = 640, H = 180, PAD = { l: 32, r: 8, t: 8, b: 20 };
  const max = Math.max(1, ...points.flatMap((p) => [p.created, p.resolved]));
  const x = (i: number) => PAD.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = (key: "created" | "resolved") => points.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const total = points.reduce((n, p) => n + p.created + p.resolved, 0);
  return (
    <figure aria-label={title}>
      <figcaption className="mb-2 flex flex-wrap items-center gap-3 text-sm font-medium text-gray-900">
        {title}
        <span className="flex items-center gap-1 text-xs font-normal text-gray-700"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="#1d4ed8" strokeWidth="2.5" /></svg>Created</span>
        <span className="flex items-center gap-1 text-xs font-normal text-gray-700"><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="#15803d" strokeWidth="2.5" strokeDasharray="5 3" /></svg>Resolved</span>
      </figcaption>
      {total === 0 ? <p className="text-sm text-gray-600">No tickets created or resolved in this period.</p> : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${points.length} days, peak ${max}`} className="h-auto w-full">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="#e5e7eb" />
              <text x={PAD.l - 4} y={y(max * f) + 3} textAnchor="end" fontSize="10" fill="#4b5563">{Math.round(max * f)}</text>
            </g>
          ))}
          <polyline points={line("created")} fill="none" stroke="#1d4ed8" strokeWidth="2" />
          <polyline points={line("resolved")} fill="none" stroke="#15803d" strokeWidth="2" strokeDasharray="5 3" />
          {points.length > 0 ? <text x={PAD.l} y={H - 4} fontSize="10" fill="#4b5563">{points[0].day}</text> : null}
          {points.length > 1 ? <text x={W - PAD.r} y={H - 4} fontSize="10" textAnchor="end" fill="#4b5563">{points[points.length - 1].day}</text> : null}
        </svg>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-blue-700">Show the numbers</summary>
        <div className="mt-2 max-h-60 overflow-auto">
          <table className="w-full text-left text-xs"><caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col" className="py-1 pr-3">Day (UTC)</th><th scope="col" className="pr-3">Created</th><th scope="col">Resolved</th></tr></thead>
            <tbody>{points.map((p) => <tr key={p.day} className="border-t border-gray-100"><th scope="row" className="py-1 pr-3 font-normal">{p.day}</th><td className="pr-3 tabular-nums">{p.created}</td><td className="tabular-nums">{p.resolved}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
