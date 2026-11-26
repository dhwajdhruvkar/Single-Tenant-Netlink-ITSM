"use client";

import { useState } from "react";
import { useTicketMutation } from "./useTicketMutation";

/** What an employee can do with their own ticket. The server decides which of these are offered (`actions.statuses`) and re-checks them. */
export function RequesterActions({ reference, version, statuses, refresh }: { reference: string; version: number; statuses: string[]; refresh?: () => void }) {
  const { run, busy, error } = useTicketMutation(reference, version, refresh);
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (statuses.length === 0) return null;
  const go = (to: string, extra: Record<string, unknown> = {}) => run("/status", "POST", { to, ...extra });
  const btn = "rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50";

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Ticket actions">
      {error ? <p role="alert" className="w-full rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error.message}</p> : null}
      {statuses.includes("closed") ? <button type="button" className={btn} disabled={busy} onClick={() => go("closed")}>Confirm it is resolved</button> : null}
      {statuses.includes("in_progress") ? <button type="button" className={btn} disabled={busy} onClick={() => go("in_progress")}>Reopen, it is not fixed</button> : null}
      {statuses.includes("cancelled") ? (
        confirmCancel ? (
          <>
            <span className="text-sm">Cancel this ticket?</span>
            <button type="button" className={btn} disabled={busy} onClick={() => go("cancelled")}>Yes, cancel it</button>
            <button type="button" className={btn} onClick={() => setConfirmCancel(false)}>No</button>
          </>
        ) : (
          <button type="button" className={btn} onClick={() => setConfirmCancel(true)}>Cancel ticket</button>
        )
      ) : null}
    </div>
  );
}
