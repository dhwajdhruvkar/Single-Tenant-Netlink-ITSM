"use client";

import { useState } from "react";
import { EmployeeSearch } from "@/ui/directory/EmployeeSearch";
import { btnClass, ghostClass, inputClass, useAdminApi } from "./useAdminApi";

export interface GroupView {
  id: string; name: string; description: string | null; email: string | null; isTriage: boolean; strategy: string; active: boolean;
  members: { employeeId: string; displayName: string; mail: string | null; role: string; available: boolean }[];
}

const STRATEGY: Record<string, string> = { manual: "Manual (agents take tickets)", round_robin: "Round robin", least_loaded: "Least loaded" };

function GroupCard({ g }: { g: GroupView }) {
  const { call, busy, error } = useAdminApi();
  const [adding, setAdding] = useState(false);
  return (
    <li className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{g.name}</h3>
        {g.isTriage ? <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">Triage</span> : null}
        {!g.active ? <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs">Inactive</span> : null}
      </div>
      {error ? <p role="alert" className="mt-1 text-sm text-red-700">{error}</p> : null}
      <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label htmlFor={`strategy-${g.id}`} className="block text-xs text-gray-600">Assignment strategy</label>
          <select id={`strategy-${g.id}`} className={inputClass} value={g.strategy} disabled={busy} onChange={(e) => call(`/api/admin/groups/${g.id}`, "PATCH", { strategy: e.target.value })}>
            {Object.entries(STRATEGY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-1"><input type="checkbox" checked={g.isTriage} disabled={busy} onChange={(e) => call(`/api/admin/groups/${g.id}`, "PATCH", { isTriage: e.target.checked })} /> Triage group</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={g.active} disabled={busy} onChange={(e) => call(`/api/admin/groups/${g.id}`, "PATCH", { active: e.target.checked })} /> Active</label>
      </div>
      <h4 className="mt-3 text-sm font-medium">Members ({g.members.length})</h4>
      <ul className="mt-1 space-y-1 text-sm">
        {g.members.map((m) => (
          <li key={m.employeeId} className="flex items-center gap-2">
            <span>{m.displayName}</span>
            <span className="text-xs text-gray-500">{m.role}{m.available ? "" : " · unavailable"}</span>
            <button type="button" className="text-xs text-blue-700 underline" disabled={busy} aria-label={`Remove ${m.displayName} from ${g.name}`} onClick={() => call(`/api/admin/groups/${g.id}/members?employeeId=${m.employeeId}`, "DELETE")}>Remove</button>
          </li>
        ))}
        {g.members.length === 0 ? <li className="text-gray-500">No members.</li> : null}
      </ul>
      {adding ? (
        <div className="mt-2 max-w-sm"><EmployeeSearch onSelect={async (e) => { if (await call(`/api/admin/groups/${g.id}/members`, "POST", { employeeId: e.id, role: "member" })) setAdding(false); }} /></div>
      ) : (
        <button type="button" className={`${ghostClass} mt-2`} onClick={() => setAdding(true)}>Add a member</button>
      )}
    </li>
  );
}

export function GroupsAdmin({ groups }: { groups: GroupView[] }) {
  const { call, busy, error } = useAdminApi();
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("manual");
  return (
    <div>
      <form className="mb-4 max-w-md rounded-md border border-gray-200 bg-white p-3" aria-label="New group" onSubmit={async (e) => { e.preventDefault(); if (await call("/api/admin/groups", "POST", { name, strategy })) setName(""); }}>
        <h2 className="font-semibold">New group</h2>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <label htmlFor="g-name" className="mt-2 block text-sm font-medium">Name</label>
        <input id="g-name" className={inputClass} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="g-strategy" className="mt-2 block text-sm font-medium">Assignment strategy</label>
        <select id="g-strategy" className={inputClass} value={strategy} onChange={(e) => setStrategy(e.target.value)}>{Object.entries(STRATEGY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button type="submit" className={`${btnClass} mt-3`} disabled={busy || name.trim().length < 2}>Create group</button>
      </form>
      <ul className="space-y-3">{groups.map((g) => <GroupCard key={g.id} g={g} />)}</ul>
    </div>
  );
}
