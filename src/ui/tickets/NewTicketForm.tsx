"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/primitives";
import { AttachmentPicker } from "./AttachmentPicker";
import { ErrorSummary } from "./ErrorSummary";
import { buildSelfPayload, EMPTY_FORM, type TicketFormValues } from "./payload";
import { RequesterCard, type RequesterProfile } from "./RequesterCard";
import { TicketFormFields, type CategoryChoice } from "./TicketFormFields";
import { useCreateTicket } from "./useCreateTicket";

/** Form B. The requester card is display-only and the request body contains no requester information at all. */
export function NewTicketForm({
  profile, categories, onCreated, attachments,
}: {
  profile: RequesterProfile;
  categories: CategoryChoice[];
  /** Omit to hide the attachment controls (feature switched off). */
  attachments?: { maxBytes: number };
  /** Overridable in tests; defaults to navigating to the new ticket. */
  onCreated?: (reference: string) => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<TicketFormValues>(EMPTY_FORM);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const { submit, submitting, error } = useCreateTicket("/api/tickets/self");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await submit(buildSelfPayload(values, attachmentIds));
    if (!result) return;
    if (onCreated) onCreated(result.reference);
    else router.push(`/my/tickets/${result.reference}?created=1`);
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="New ticket">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields ?? {}} />
      <div className="mb-4"><RequesterCard profile={profile} title="Requesting as" /></div>
      <TicketFormFields values={values} onChange={(p) => setValues((v) => ({ ...v, ...p }))} errors={error?.fields ?? {}} categories={categories} />
      {attachments ? <AttachmentPicker maxBytes={attachments.maxBytes} onChange={setAttachmentIds} onBusyChange={setUploading} /> : null}
      <Button type="submit" disabled={submitting || uploading}>{uploading ? "Uploading files…" : submitting ? "Submitting…" : "Submit ticket"}</Button>
    </form>
  );
}
