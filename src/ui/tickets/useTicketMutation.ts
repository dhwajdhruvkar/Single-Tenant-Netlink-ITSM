"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

export interface MutationError {
  message: string;
  /** true when the ticket changed under us (409 STALE_VERSION / illegal transition): the page is being refreshed */
  conflict: boolean;
  fields: Record<string, string>;
}

/**
 * Sends one change to a ticket and refreshes the page on success. Every call carries the ticket `version`; a 409 means someone else
 * changed the ticket, so the user is told and the page reloads with the current state instead of silently overwriting it.
 */
export function useTicketMutation(reference: string, version: number, refresh?: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MutationError | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/tickets/${encodeURIComponent(reference)}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(path === "/messages" ? body : { version, ...body }),
        });
        if (res.ok) {
          (refresh ?? (() => router.refresh()))();
          return true;
        }
        const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: { issues?: { path: string; message: string }[] } } } | null;
        const conflict = res.status === 409;
        const fields: Record<string, string> = {};
        for (const i of json?.error?.details?.issues ?? []) if (i.path && !fields[i.path]) fields[i.path] = i.message;
        setError({
          conflict,
          fields,
          message: conflict && json?.error?.code === "STALE_VERSION"
            ? "Someone else changed this ticket. It has been reloaded; check the latest state and try again."
            : json?.error?.message ?? "That did not work. Please try again.",
        });
        if (conflict) (refresh ?? (() => router.refresh()))();
        return false;
      } catch {
        setError({ conflict: false, fields: {}, message: "Network error. Nothing was changed; try again." });
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [reference, version, refresh, router],
  );

  return { run, busy, error, clearError: () => setError(null) };
}
