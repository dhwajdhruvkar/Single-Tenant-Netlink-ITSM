"use client";

import { useState } from "react";
import { btnClass, inputClass, useAdminApi } from "./useAdminApi";

export interface CategoryView { id: string; name: string; parentId: string | null; ticketTypes: string[]; defaultGroupId: string | null; sortOrder: number; active: boolean }

export function CategoriesAdmin({ categories, groups }: { categories: CategoryView[]; groups: { id: string; name: string }[] }) {
  const { call, busy, error } = useAdminApi();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [type, setType] = useState("");
  const [groupId, setGroupId] = useState("");
  const byId = new Map(categories.map((c) => [c.id, c]));
  const label = (c: CategoryView) => (c.parentId && byId.get(c.parentId) ? `${byId.get(c.parentId)!.name} › ${c.name}` : c.name);
  return (
    <div>
      <form className="mb-4 max-w-md rounded-md border border-gray-200 bg-white p-3" aria-label="New category" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await call("/api/admin/categories", "POST", { name, ...(parentId ? { parentId } : {}), ticketTypes: type ? [type] : [], ...(groupId ? { defaultGroupId: groupId } : {}) });
        if (ok) setName("");
      }}>
        <h2 className="font-semibold">New category</h2>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <label htmlFor="c-name" className="mt-2 block text-sm font-medium">Name</label>
        <input id="c-name" className={inputClass} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="c-parent" className="mt-2 block text-sm font-medium">Parent (optional)</label>
        <select id="c-parent" className={inputClass} value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">Top level</option>{categories.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}</select>
        <label htmlFor="c-type" className="mt-2 block text-sm font-medium">Applies to</label>
        <select id="c-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value)}><option value="">Incidents and requests</option><option value="incident">Incidents only</option><option value="service_request">Service requests only</option></select>
        <label htmlFor="c-group" className="mt-2 block text-sm font-medium">Default group (optional)</label>
        <select id="c-group" className={inputClass} value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">Route to triage</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        <button type="submit" className={`${btnClass} mt-3`} disabled={busy || !name.trim()}>Create category</button>
      </form>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Categories</caption>
        <thead className="border-b text-xs uppercase text-gray-500"><tr><th scope="col" className="px-2 py-1">Category</th><th scope="col" className="px-2 py-1">Applies to</th><th scope="col" className="px-2 py-1">Default group</th><th scope="col" className="px-2 py-1">Active</th></tr></thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id} className="border-b border-gray-100">
              <td className="px-2 py-1">{label(c)}</td>
              <td className="px-2 py-1">{c.ticketTypes.length ? c.ticketTypes.join(", ").replace(/_/g, " ") : "all types"}</td>
              <td className="px-2 py-1">{groups.find((g) => g.id === c.defaultGroupId)?.name ?? "triage"}</td>
              <td className="px-2 py-1"><label className="flex items-center gap-1"><input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => call(`/api/admin/categories/${c.id}`, "PATCH", { active: e.target.checked })} /><span className="sr-only">{c.name} active</span></label></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
