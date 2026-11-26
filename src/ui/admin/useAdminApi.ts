"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

/** Sends one admin change, refreshes the page on success and exposes the server's error message (including field messages). */
export function useAdminApi() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const call = useCallback(async (url: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (res.ok) {
        router.refresh();
        return true;
      }
      const json = (await res.json().catch(() => null)) as { error?: { message?: string; details?: { issues?: { path: string; message: string }[] } } } | null;
      const issue = json?.error?.details?.issues?.[0];
      setError(issue ? `${issue.path || "request"}: ${issue.message}` : (json?.error?.message ?? "That did not work."));
      return false;
    } catch {
      setError("Network error. Nothing was changed.");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [router]);

  return { call, busy, error };
}

export const inputClass = "mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
export const btnClass = "rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50";
export const ghostClass = "rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50";
