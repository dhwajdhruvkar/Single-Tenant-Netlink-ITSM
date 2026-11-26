"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { EmployeeSearch, type EmployeeResult } from "@/ui/directory/EmployeeSearch";
import { Button } from "@/ui/primitives";
import { AgentOnlyFields, type GroupChoice } from "./AgentOnlyFields";
import { AttachmentPicker } from "./AttachmentPicker";
import { ErrorSummary } from "./ErrorSummary";
import { buildAssistedPayload, EMPTY_AGENT_FIELDS, EMPTY_FORM, type AgentFields, type TicketFormValues } from "./payload";
import { RequesterCard } from "./RequesterCard";
import { TicketFormFields, type CategoryChoice } from "./TicketFormFields";
import { useCreateTicket } from "./useCreateTicket";

export interface RecentTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
}

/**
 * Form A. The ONLY requester information submitted is the selected employee's id; the card is display-only, and selecting a
 * different person replaces it. "Created by" is shown read-only.
 */
export function AssistedTicketForm({
  agentName, categories, groups, canOverride, onCreated, loadRecent, attachments,
}: {
  agentName: string;
  categories: CategoryChoice[];
  groups: GroupChoice[];
  canOverride: boolean;
  onCreated?: (reference: string) => void;
  loadRecent?: (employeeId: string) => Promise<RecentTicket[]>;
  attachments?: { maxBytes: number };
}) {
  const router = useRouter();
  const [values, setValues] = useState<TicketFormValues>(EMPTY_FORM);
  const [agent, setAgent] = useState<AgentFields>(EMPTY_AGENT_FIELDS);
  const [requester, setRequester] = useState<EmployeeResult | null>(null);
  const [recent, setRecent] = useState<RecentTicket[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const { submit, submitting, error } = useCreateTicket("/api/tickets/assisted");

  async function select(e: EmployeeResult) {
    selectedId.current = e.id;
    setRequester(e);
    setLocalError(null);
    setRecent([]);
    if (loadRecent) {
      try {
        const items = await loadRecent(e.id);
        // A slow lookup for a previously selected person must never show their tickets under the new selection.
        if (selectedId.current === e.id) setRecent(items);
      } catch {
        if (selectedId.current === e.id) setRecent([]);
      }
    }
  }

  function clearRequester() {
    selectedId.current = null;
    setRequester(null);
    setRecent([]);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (!requester) return setLocalError("Select the employee this ticket is for.");
    const result = await submit(buildAssistedPayload(values, requester.id, agent, attachmentIds));
    if (!result) return;
    if (onCreated) onCreated(result.reference);
    else router.push(`/desk/tickets/${result.reference}?created=1`);
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="New ticket on behalf of an employee">
      <ErrorSummary message={localError ?? error?.message ?? null} fields={error?.fields ?? {}} />

      {requester ? (
        <div className="mb-4">
          <RequesterCard profile={{ displayName: requester.displayName, mail: requester.mail ?? requester.userPrincipalName, department: requester.department, jobTitle: requester.jobTitle, officeLocation: requester.officeLocation }} />
          <button type="button" className="mt-1 text-xs text-blue-700 underline" onClick={clearRequester}>Choose a different employee</button>
        </div>
      ) : (
        <div className="mb-4"><EmployeeSearch onSelect={select} /></div>
      )}

      <p className="mb-4 text-sm text-gray-600">Created by: <strong>{agentName}</strong></p>

      {recent.length > 0 ? (
        <aside className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm" aria-label="Recent tickets for this employee">
          <h2 className="font-semibold text-amber-900">Recent tickets for this employee</h2>
          <ul className="mt-1 list-disc pl-5">
            {recent.map((t) => <li key={t.id}>{t.reference}: {t.subject} ({t.status})</li>)}
          </ul>
        </aside>
      ) : null}

      <AgentOnlyFields value={agent} onChange={(p) => setAgent((a) => ({ ...a, ...p }))} groups={groups} errors={error?.fields ?? {}} canOverride={canOverride} />
      <TicketFormFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={error?.fields ?? {}} categories={categories} />
      {attachments ? <AttachmentPicker maxBytes={attachments.maxBytes} onChange={setAttachmentIds} onBusyChange={setUploading} /> : null}
      <Button type="submit" disabled={submitting || uploading}>{uploading ? "Uploading files…" : submitting ? "Submitting…" : "Create ticket"}</Button>
    </form>
  );
}
