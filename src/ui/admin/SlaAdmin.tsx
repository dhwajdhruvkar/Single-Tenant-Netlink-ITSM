"use client";

import { useState } from "react";
import { btnClass, ghostClass, inputClass, useAdminApi } from "./useAdminApi";

export interface PolicyView { id: string; name: string; priority: string; ticketType: string | null; responseMinutes: number; resolveMinutes: number; calendarId: string | null; active: boolean }
export interface CalendarView { id: string; name: string; timezone: string; workDays: number[]; startMinute: number; endMinute: number; holidays: { id: string; date: string; name: string }[] }

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

export function SlaAdmin({ policies, calendars }: { policies: PolicyView[]; calendars: CalendarView[] }) {
  const { call, busy, error } = useAdminApi();
  const [p, setP] = useState({ name: "", priority: "p3", ticketType: "", responseMinutes: "60", resolveMinutes: "480", calendarId: "" });
  const [c, setC] = useState({ name: "", timezone: "UTC", start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] });
  const [h, setH] = useState<Record<string, { date: string; name: string }>>({});
  return (
    <div className="space-y-8">
      {error ? <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p> : null}

      <section aria-labelledby="pol">
        <h2 id="pol" className="text-lg font-semibold">SLA policies</h2>
        <p className="text-xs text-gray-500">Changes apply to tickets created (or re-prioritised) from now on; existing due dates are kept. Only one active policy per priority and type.</p>
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">SLA policies</caption>
          <thead className="border-b text-xs uppercase text-gray-500"><tr><th scope="col" className="px-2 py-1">Name</th><th scope="col" className="px-2 py-1">Priority</th><th scope="col" className="px-2 py-1">Type</th><th scope="col" className="px-2 py-1">Response</th><th scope="col" className="px-2 py-1">Resolve</th><th scope="col" className="px-2 py-1">Calendar</th><th scope="col" className="px-2 py-1">Active</th></tr></thead>
          <tbody>{policies.map((x) => (
            <tr key={x.id} className="border-b border-gray-100">
              <td className="px-2 py-1">{x.name}</td><td className="px-2 py-1">{x.priority.toUpperCase()}</td><td className="px-2 py-1">{x.ticketType?.replace("_", " ") ?? "all"}</td>
              <td className="px-2 py-1">{x.responseMinutes} min</td><td className="px-2 py-1">{x.resolveMinutes} min</td><td className="px-2 py-1">{calendars.find((k) => k.id === x.calendarId)?.name ?? "24x7"}</td>
              <td className="px-2 py-1"><label className="flex items-center gap-1"><input type="checkbox" checked={x.active} disabled={busy} onChange={(e) => call(`/api/admin/sla/policies/${x.id}`, "PATCH", { active: e.target.checked })} /><span className="sr-only">{x.name} active</span></label></td>
            </tr>))}</tbody>
        </table>
        <form className="mt-3 grid max-w-xl grid-cols-2 gap-2 rounded-md border border-gray-200 bg-white p-3" aria-label="New SLA policy" onSubmit={async (e) => {
          e.preventDefault();
          await call("/api/admin/sla/policies", "POST", { name: p.name, priority: p.priority, ...(p.ticketType ? { ticketType: p.ticketType } : {}), responseMinutes: Number(p.responseMinutes), resolveMinutes: Number(p.resolveMinutes), ...(p.calendarId ? { calendarId: p.calendarId } : {}) });
        }}>
          <div className="col-span-2"><label htmlFor="p-name" className="block text-sm font-medium">Name</label><input id="p-name" className={inputClass} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
          <div><label htmlFor="p-pri" className="block text-sm font-medium">Priority</label><select id="p-pri" className={inputClass} value={p.priority} onChange={(e) => setP({ ...p, priority: e.target.value })}>{["p1", "p2", "p3", "p4"].map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}</select></div>
          <div><label htmlFor="p-type" className="block text-sm font-medium">Ticket type</label><select id="p-type" className={inputClass} value={p.ticketType} onChange={(e) => setP({ ...p, ticketType: e.target.value })}><option value="">All types</option><option value="incident">Incident</option><option value="service_request">Service request</option></select></div>
          <div><label htmlFor="p-resp" className="block text-sm font-medium">First response (minutes)</label><input id="p-resp" type="number" min={1} className={inputClass} value={p.responseMinutes} onChange={(e) => setP({ ...p, responseMinutes: e.target.value })} /></div>
          <div><label htmlFor="p-res" className="block text-sm font-medium">Resolution (minutes)</label><input id="p-res" type="number" min={1} className={inputClass} value={p.resolveMinutes} onChange={(e) => setP({ ...p, resolveMinutes: e.target.value })} /></div>
          <div className="col-span-2"><label htmlFor="p-cal" className="block text-sm font-medium">Calendar</label><select id="p-cal" className={inputClass} value={p.calendarId} onChange={(e) => setP({ ...p, calendarId: e.target.value })}><option value="">24x7</option>{calendars.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></div>
          <div className="col-span-2"><button type="submit" className={btnClass} disabled={busy || !p.name.trim()}>Create policy</button></div>
        </form>
      </section>

      <section aria-labelledby="cal">
        <h2 id="cal" className="text-lg font-semibold">Business calendars</h2>
        <ul className="mt-2 space-y-3">{calendars.map((k) => (
          <li key={k.id} className="rounded-md border border-gray-200 bg-white p-3 text-sm">
            <p className="font-medium">{k.name} <span className="font-normal text-gray-500">· {k.timezone} · {k.workDays.map((d) => DAYS[d - 1]).join(", ")} · {hhmm(k.startMinute)}–{hhmm(k.endMinute)}</span></p>
            <ul className="mt-1">{k.holidays.map((x) => (<li key={x.id}>{x.date} {x.name} <button type="button" className="text-xs text-blue-700 underline" disabled={busy} aria-label={`Remove holiday ${x.name}`} onClick={() => call(`/api/admin/sla/calendars/${k.id}/holidays?holidayId=${x.id}`, "DELETE")}>Remove</button></li>))}</ul>
            <form className="mt-2 flex flex-wrap items-end gap-2" aria-label={`Add holiday to ${k.name}`} onSubmit={async (e) => { e.preventDefault(); const v = h[k.id]; if (v?.date && v.name && await call(`/api/admin/sla/calendars/${k.id}/holidays`, "POST", v)) setH({ ...h, [k.id]: { date: "", name: "" } }); }}>
              <div><label htmlFor={`hd-${k.id}`} className="block text-xs">Date</label><input id={`hd-${k.id}`} type="date" className={inputClass} value={h[k.id]?.date ?? ""} onChange={(e) => setH({ ...h, [k.id]: { date: e.target.value, name: h[k.id]?.name ?? "" } })} /></div>
              <div><label htmlFor={`hn-${k.id}`} className="block text-xs">Name</label><input id={`hn-${k.id}`} className={inputClass} value={h[k.id]?.name ?? ""} onChange={(e) => setH({ ...h, [k.id]: { date: h[k.id]?.date ?? "", name: e.target.value } })} /></div>
              <button type="submit" className={ghostClass} disabled={busy}>Add holiday</button>
            </form>
          </li>))}</ul>
        <form className="mt-3 grid max-w-xl grid-cols-2 gap-2 rounded-md border border-gray-200 bg-white p-3" aria-label="New calendar" onSubmit={async (e) => { e.preventDefault(); await call("/api/admin/sla/calendars", "POST", { name: c.name, timezone: c.timezone, workDays: c.days, startMinute: toMinutes(c.start), endMinute: toMinutes(c.end) }); }}>
          <div><label htmlFor="k-name" className="block text-sm font-medium">Name</label><input id="k-name" className={inputClass} value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></div>
          <div><label htmlFor="k-tz" className="block text-sm font-medium">Time zone (IANA)</label><input id="k-tz" className={inputClass} value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })} /></div>
          <div><label htmlFor="k-start" className="block text-sm font-medium">Opens</label><input id="k-start" type="time" className={inputClass} value={c.start} onChange={(e) => setC({ ...c, start: e.target.value })} /></div>
          <div><label htmlFor="k-end" className="block text-sm font-medium">Closes</label><input id="k-end" type="time" className={inputClass} value={c.end} onChange={(e) => setC({ ...c, end: e.target.value })} /></div>
          <fieldset className="col-span-2"><legend className="text-sm font-medium">Working days</legend><div className="flex flex-wrap gap-3 text-sm">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={c.days.includes(i + 1)} onChange={(e) => setC({ ...c, days: e.target.checked ? [...c.days, i + 1] : c.days.filter((x) => x !== i + 1) })} />{d}</label>)}</div></fieldset>
          <div className="col-span-2"><button type="submit" className={btnClass} disabled={busy || !c.name.trim() || c.days.length === 0}>Create calendar</button></div>
        </form>
      </section>
    </div>
  );
}
