"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/primitives";
import { AttachmentPicker } from "./AttachmentPicker";
import { useTicketMutation } from "./useTicketMutation";

/** Reply box. Agents can switch to an internal note; employees only ever see (and send) public replies. */
export function MessageComposer({
  reference, version, canNote, attachments, refresh,
}: {
  reference: string;
  version: number;
  canNote: boolean;
  attachments?: { maxBytes: number };
  refresh?: () => void;
}) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const { run, busy, error } = useTicketMutation(reference, version, refresh);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    const ok = await run("/messages", "POST", { body, visibility: internal ? "internal" : "public", attachmentIds: ids });
    if (ok) {
      setBody("");
      setIds([]);
      setPickerKey((k) => k + 1);
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Add a message" className="mt-4">
      {error ? <p role="alert" className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error.message}</p> : null}
      <label htmlFor="message-body" className="block text-sm font-medium text-gray-800">{internal ? "Internal note (not visible to the requester)" : "Reply"}</label>
      <textarea
        id="message-body"
        className={`mt-1 min-h-24 w-full rounded-md border px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${internal ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
        value={body}
        maxLength={10000}
        onChange={(e) => setBody(e.target.value)}
      />
      {canNote ? (
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Internal note (agents only)
        </label>
      ) : null}
      {attachments ? <div className="mt-2"><AttachmentPicker key={pickerKey} maxBytes={attachments.maxBytes} onChange={setIds} onBusyChange={setUploading} /></div> : null}
      <Button type="submit" disabled={busy || uploading || !body.trim()}>{busy ? "Sending…" : internal ? "Add note" : "Send reply"}</Button>
    </form>
  );
}
