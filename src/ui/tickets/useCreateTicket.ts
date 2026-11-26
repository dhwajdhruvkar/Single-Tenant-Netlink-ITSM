"use client";

import { useCallback, useRef, useState } from "react";

export interface CreateError {
  message: string;
  /** field path -> message, from the server's validation issues */
  fields: Record<string, string>;
}

export interface CreateResult {
  reference: string;
  replayed: boolean;
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Posts a ticket with an Idempotency-Key that lives for the form's mount, so a double click or a retry after a network error
 * cannot create two tickets. After a 4xx the key is replaced (the user is about to change the body, and the same key with a
 * different body would be rejected as a conflict). Network errors and 5xx keep the key: retrying is exactly what it is for.
 */
export function useCreateTicket(endpoint: string) {
  const keyRef = useRef<string>(newKey());
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CreateError | null>(null);

  const submit = useCallback(
    async (payload: Record<string, unknown>): Promise<CreateResult | null> => {
      if (inFlight.current) return null; // ignore double submits
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": keyRef.current },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => null)) as { data?: { reference?: string }; error?: { message?: string; details?: { issues?: { path: string; message: string }[] } } } | null;
        if (res.ok && body?.data?.reference) return { reference: body.data.reference, replayed: res.status === 200 };

        const fields: Record<string, string> = {};
        for (const i of body?.error?.details?.issues ?? []) if (i.path && !fields[i.path]) fields[i.path] = i.message;
        setError({ message: body?.error?.message ?? "The ticket could not be created.", fields });
        if (res.status >= 400 && res.status < 500) keyRef.current = newKey();
        return null;
      } catch {
        setError({ message: "Network error. Your ticket was not lost; try again.", fields: {} });
        return null; // keep the key
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [endpoint],
  );

  return { submit, submitting, error };
}
