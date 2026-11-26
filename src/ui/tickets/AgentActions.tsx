"use client";

import { useState } from "react";
import { useTicketMutation } from "./useTicketMutation";
import type { GroupChoice } from "./AgentOnlyFields";

const sel = "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
const btn = "rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50";
const ghost = "rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50";

const HOLD_LABEL: Record<string, string> = { awaiting_requester: "Waiting for the requester", awaiting_vendor: "Waiting for a vendor", awaiting_change: "Waiting for a change", scheduled: "Scheduled", other: "Other" };
const STATUS_LABEL: Record<string, string> = { in_progress: "Start work", on_hold: "Put on hold", resolved: "Resolve", cancelled: "Cancel ticket", closed: "Close", assigned: "Assigned" };

export interface AgentActionsProps {
  reference: string;
  version: number;
  me: string;
  statuses: string[];
  canAssign: boolean;
  canEdit: boolean;
  canArchive: boolean;
  groups: GroupChoice[];
  current: { groupId: string | null; assigneeId: string | null; priority: string; impact: string; urgency: string; priorityOverridden: boolean };
  refresh?: () => void;
}

/** Agent controls. Everything shown here is derived from the server's `actions`; the API enforces the same rules again. */
export function AgentActions(p: AgentActionsProps) {
  const { run, busy, error } = useTicketMutation(p.reference, p.version, p.refresh);
  const [panel, setPanel] = useState<null | "hold" | "resolve">(null);
  const [holdReason, setHoldReason] = useState("awaiting_requester");
  const [notes, setNotes] = useState("");
  const [code, setCode] = useState("");
  const [groupId, setGroupId] = useState(p.current.groupId ?? "");
  const [assignee, setAssignee] = useState(p.current.assigneeId ?? "");
  const [impact, setImpact] = useState(p.current.impact);
  const [urgency, setUrgency] = useState(p.current.urgency);
  const [override, setOverride] = useState(p.current.priority);
  const [overrideReason, setOverrideReason] = useState("");
  const [archiveReason, setArchiveReason] = useState("");

  const members = p.groups.find((g) => g.id === groupId)?.members ?? [];
  const simple = p.statuses.filter((s) => s === "in_progress" || s === "cancelled" || s === "closed");

  return (
    <section aria-label="Agent actions" className="rounded-md border border-gray-200 bg-white p-3 text-sm">
      {error ? <p role="alert" className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-red-800">{error.message}</p> : null}

      <h2 className="font-semibold text-gray-800">Status</h2>
      <div className="mt-1 flex flex-wrap gap-2">
        {simple.map((s) => <button key={s} type="button" className={ghost} disabled={busy} onClick={() => run("/status", "POST", { to: s })}>{STATUS_LABEL[s]}</button>)}
        {p.statuses.includes("on_hold") ? <button type="button" className={ghost} onClick={() => setPanel(panel === "hold" ? null : "hold")}>{STATUS_LABEL.on_hold}…</button> : null}
        {p.statuses.includes("resolved") ? <button type="button" className={ghost} onClick={() => setPanel(panel === "resolve" ? null : "resolve")}>{STATUS_LABEL.resolved}…</button> : null}
        {p.statuses.length === 0 ? <span className="text-gray-500">No status changes available.</span> : null}
      </div>

      {panel === "hold" ? (
        <div className="mt-2">
          <label htmlFor="hold-reason" className="block font-medium">Why is it on hold?</label>
          <select id="hold-reason" className={sel} value={holdReason} onChange={(e) => setHoldReason(e.target.value)}>
            {Object.entries(HOLD_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className={`${btn} mt-2`} disabled={busy} onClick={() => run("/status", "POST", { to: "on_hold", holdReason })}>Put on hold</button>
        </div>
      ) : null}

      {panel === "resolve" ? (
        <div className="mt-2">
          <label htmlFor="res-code" className="block font-medium">Resolution code (optional)</label>
          <input id="res-code" className={sel} value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />
          <label htmlFor="res-notes" className="mt-2 block font-medium">What was done? (optional)</label>
          <textarea id="res-notes" className={`${sel} min-h-20`} value={notes} maxLength={10000} onChange={(e) => setNotes(e.target.value)} />
          <button type="button" className={`${btn} mt-2`} disabled={busy} onClick={() => run("/status", "POST", { to: "resolved", ...(code.trim() ? { resolutionCode: code.trim() } : {}), ...(notes.trim() ? { resolutionNotes: notes.trim() } : {}) })}>Resolve ticket</button>
        </div>
      ) : null}

      {p.canAssign ? (
        <>
          <h2 className="mt-4 font-semibold text-gray-800">Assignment</h2>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <button type="button" className={ghost} disabled={busy || p.current.assigneeId === p.me} onClick={() => run("/assignment", "POST", { assigneeEmployeeId: "me" })}>Assign to me</button>
            {p.current.assigneeId ? <button type="button" className={ghost} disabled={busy} onClick={() => run("/assignment", "POST", { assigneeEmployeeId: null })}>Unassign</button> : null}
          </div>
          <label htmlFor="assign-group" className="mt-2 block font-medium">Group</label>
          <select id="assign-group" className={sel} value={groupId} onChange={(e) => { setGroupId(e.target.value); setAssignee(""); }}>
            <option value="">(no group)</option>
            {p.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <label htmlFor="assign-person" className="mt-2 block font-medium">Assignee</label>
          <select id="assign-person" className={sel} value={assignee} disabled={!groupId} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <button
            type="button" className={`${btn} mt-2`} disabled={busy || !groupId}
            onClick={() => run("/assignment", "POST", { ...(groupId && groupId !== (p.current.groupId ?? "") ? { groupId } : {}), ...(assignee !== (p.current.assigneeId ?? "") ? { assigneeEmployeeId: assignee || null } : {}) })}
          >Save assignment</button>
        </>
      ) : null}

      {p.canEdit ? (
        <>
          <h2 className="mt-4 font-semibold text-gray-800">Priority</h2>
          <p className="text-xs text-gray-500">Currently {p.current.priority.toUpperCase()}{p.current.priorityOverridden ? " (overridden)" : ""}.</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="edit-impact" className="block font-medium">Impact</label>
              <select id="edit-impact" className={sel} value={impact} onChange={(e) => setImpact(e.target.value)}>{["low", "medium", "high"].map((v) => <option key={v}>{v}</option>)}</select>
            </div>
            <div>
              <label htmlFor="edit-urgency" className="block font-medium">Urgency</label>
              <select id="edit-urgency" className={sel} value={urgency} onChange={(e) => setUrgency(e.target.value)}>{["low", "medium", "high"].map((v) => <option key={v}>{v}</option>)}</select>
            </div>
          </div>
          <button type="button" className={`${ghost} mt-2`} disabled={busy || (impact === p.current.impact && urgency === p.current.urgency)} onClick={() => run("", "PATCH", { impact, urgency })}>Update impact and urgency</button>

          <label htmlFor="edit-priority" className="mt-3 block font-medium">Override priority</label>
          <select id="edit-priority" className={sel} value={override} onChange={(e) => setOverride(e.target.value)}>{["p1", "p2", "p3", "p4"].map((v) => <option key={v} value={v}>{v.toUpperCase()}</option>)}</select>
          <label htmlFor="edit-priority-reason" className="mt-2 block font-medium">Reason (required)</label>
          <input id="edit-priority-reason" className={sel} value={overrideReason} maxLength={500} onChange={(e) => setOverrideReason(e.target.value)} />
          <button type="button" className={`${ghost} mt-2`} disabled={busy || overrideReason.trim().length < 3} onClick={() => run("", "PATCH", { priority: override, reason: overrideReason.trim() })}>Apply override</button>
          {p.current.priorityOverridden ? <button type="button" className={`${ghost} ml-2 mt-2`} disabled={busy} onClick={() => run("", "PATCH", { priority: null })}>Clear override</button> : null}
        </>
      ) : null}

      {p.canArchive ? (
        <>
          <h2 className="mt-4 font-semibold text-gray-800">Archive</h2>
          <label htmlFor="archive-reason" className="block text-xs text-gray-500">Archived tickets disappear from every list. Optional reason:</label>
          <input id="archive-reason" className={sel} value={archiveReason} maxLength={500} onChange={(e) => setArchiveReason(e.target.value)} />
          <button type="button" className={`${ghost} mt-2`} disabled={busy} onClick={() => run("/archive", "POST", archiveReason.trim().length >= 3 ? { reason: archiveReason.trim() } : {})}>Archive ticket</button>
        </>
      ) : null}
    </section>
  );
}
