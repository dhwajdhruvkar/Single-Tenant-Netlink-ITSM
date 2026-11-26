"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps a server-rendered page fresh by re-running its server component on an interval. It only polls while the tab is visible and
 * refreshes once when the tab becomes visible again. Plain polling (no SSE) so it works the same behind any proxy and on any host.
 */
export function useLivePolling(intervalMs = 30_000): void {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);
}

export function LivePoller({ intervalMs }: { intervalMs?: number }) {
  useLivePolling(intervalMs);
  return null;
}
