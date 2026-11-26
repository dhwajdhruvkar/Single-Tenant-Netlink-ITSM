import type { SlaLevel } from "@/modules/sla/status";

const LABEL: Record<SlaLevel, string> = { none: "No SLA", paused: "SLA paused", met: "SLA met", on_track: "On track", at_risk: "At risk", breached: "Breached" };
const STYLE: Record<SlaLevel, string> = {
  none: "bg-gray-100 text-gray-700", paused: "bg-blue-100 text-blue-800", met: "bg-green-100 text-green-800",
  on_track: "bg-green-100 text-green-800", at_risk: "bg-amber-100 text-amber-900", breached: "bg-red-100 text-red-800",
};

/** Colour is never the only signal: the level is always spelled out. */
export function SlaBadge({ level }: { level: SlaLevel }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STYLE[level]}`}>{LABEL[level]}</span>;
}
