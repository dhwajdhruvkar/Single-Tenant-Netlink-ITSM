"use client";

import { useId, useRef, useState } from "react";

export const MAX_FILES = 10;

interface Item {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "error";
  id?: string;
  error?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Uploads each chosen file straight away (stages it on the server) and reports the ids of the successful ones. The server is the
 * authority on type and size; the client checks are only for a faster message. Files can be removed before the ticket is submitted.
 */
export function AttachmentPicker({
  maxBytes, onChange, onBusyChange, uploadUrl = "/api/attachments", maxFiles = MAX_FILES,
}: {
  maxBytes: number;
  onChange: (ids: string[]) => void;
  onBusyChange?: (busy: boolean) => void;
  uploadUrl?: string;
  maxFiles?: number;
}) {
  const inputId = useId();
  const [items, setItems] = useState<Item[]>([]);
  const ref = useRef<Item[]>([]);
  const counter = useRef(0);

  function commit(next: Item[]) {
    ref.current = next;
    setItems(next);
    onChange(next.filter((i) => i.state === "done" && i.id).map((i) => i.id as string));
    onBusyChange?.(next.some((i) => i.state === "uploading"));
  }
  const patch = (key: string, p: Partial<Item>) => commit(ref.current.map((i) => (i.key === key ? { ...i, ...p } : i)));

  async function upload(file: File, key: string) {
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(uploadUrl, { method: "POST", body });
      const json = (await res.json().catch(() => null)) as { data?: { id: string }; error?: { message?: string } } | null;
      if (res.ok && json?.data?.id) patch(key, { state: "done", id: json.data.id });
      else patch(key, { state: "error", error: json?.error?.message ?? (res.status === 413 ? "The file is too large." : "Upload failed.") });
    } catch {
      patch(key, { state: "error", error: "Upload failed. Check your connection." });
    }
  }

  function onPick(files: FileList | null) {
    if (!files) return;
    const next = [...ref.current];
    const started: { file: File; key: string }[] = [];
    for (const file of Array.from(files)) {
      const key = `f${++counter.current}`;
      const active = next.filter((i) => i.state !== "error").length;
      if (active >= maxFiles) next.push({ key, name: file.name, size: file.size, state: "error", error: `At most ${maxFiles} files.` });
      else if (file.size > maxBytes) next.push({ key, name: file.name, size: file.size, state: "error", error: `Larger than ${formatBytes(maxBytes)}.` });
      else if (file.size === 0) next.push({ key, name: file.name, size: file.size, state: "error", error: "The file is empty." });
      else {
        next.push({ key, name: file.name, size: file.size, state: "uploading" });
        started.push({ file, key });
      }
    }
    commit(next);
    for (const s of started) void upload(s.file, s.key);
  }

  function remove(item: Item) {
    commit(ref.current.filter((i) => i.key !== item.key));
    if (item.id) void fetch(`${uploadUrl}/${item.id}`, { method: "DELETE" }).catch(() => undefined); // best effort; cleanup job covers failures
  }

  return (
    <div className="mb-4">
      <label htmlFor={inputId} className="block text-sm font-medium text-gray-800">Attachments (optional)</label>
      <p className="text-xs text-gray-500">Up to {maxFiles} files, {formatBytes(maxBytes)} each. Screenshots, PDFs, Office files, text and zip files are accepted.</p>
      <input id={inputId} type="file" multiple className="mt-1 block text-sm" onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
      <ul aria-live="polite" className="mt-2 space-y-1">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-sm">
            <span className={i.state === "error" ? "text-red-700" : "text-gray-900"}>{i.name}</span>
            <span className="text-xs text-gray-500">({formatBytes(i.size)})</span>
            {i.state === "uploading" ? <span className="text-xs text-gray-500">Uploading…</span> : null}
            {i.state === "done" ? <span className="text-xs text-green-700">Uploaded</span> : null}
            {i.state === "error" ? <span role="alert" className="text-xs text-red-700">{i.error}</span> : null}
            <button type="button" className="text-xs text-blue-700 underline" onClick={() => remove(i)} aria-label={`Remove ${i.name}`}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
