"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface Item { id: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }

export const BELL_POLL_MS = 60_000;

/**
 * Header bell: shows the unread count and the latest notifications, polling every 60 s while the tab is visible. It renders nothing when
 * the user is not signed in (the API answers 401), so it is safe in the shared shell.
 */
export function NotificationBell({ pollMs = BELL_POLL_MS }: { pollMs?: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=10");
      if (!mounted.current) return;
      if (res.status === 401) return setItems(null);
      if (!res.ok) return setFailed(true);
      const body = (await res.json()) as { data: Item[]; meta: { unread: number } };
      setItems(body.data);
      setUnread(body.meta.unread);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = setTimeout(() => void load(), 0); // not synchronously inside the effect
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", tick);
    return () => { mounted.current = false; clearTimeout(first); clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [load, pollMs]);

  async function markRead(body: Record<string, unknown>) {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    void load();
  }

  if (items === null) return null;
  return (
    <div className="relative">
      <button type="button" className="relative rounded-md px-2 py-1 text-sm hover:bg-gray-100" aria-haspopup="true" aria-expanded={open} aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 ? <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs font-medium text-white">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div role="region" aria-label="Notifications" className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
          <div className="flex items-center justify-between px-1 pb-1">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread > 0 ? <button type="button" className="text-xs text-blue-700 underline" onClick={() => markRead({ all: true })}>Mark all read</button> : null}
          </div>
          {failed ? <p role="alert" className="px-1 text-xs text-red-700">Could not refresh. Showing the last known list.</p> : null}
          {items.length === 0 ? <p className="px-1 py-2 text-sm text-gray-600">No notifications.</p> : (
            <ul className="max-h-96 divide-y divide-gray-100 overflow-auto">
              {items.map((n) => (
                <li key={n.id} className={`px-1 py-2 text-sm ${n.read ? "" : "bg-blue-50"}`}>
                  {n.link ? <Link href={n.link} className="font-medium text-blue-800 underline" onClick={() => { setOpen(false); void markRead({ ids: [n.id] }); }}>{n.title}</Link> : <span className="font-medium">{n.title}</span>}
                  {n.body ? <p className="text-xs text-gray-700">{n.body}</p> : null}
                  <p className="text-xs text-gray-500">{n.createdAt.slice(0, 16).replace("T", " ")} UTC{n.read ? "" : " · unread"}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
