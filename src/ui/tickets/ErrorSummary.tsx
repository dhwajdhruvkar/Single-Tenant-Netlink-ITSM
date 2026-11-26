"use client";

import { useEffect, useRef } from "react";

/** Announces a submit failure and moves focus to it, so keyboard and screen-reader users notice it. */
export function ErrorSummary({ message, fields }: { message: string | null; fields: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message, fields]);
  if (!message) return null;
  const entries = Object.entries(fields);
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-medium">{message}</p>
      {entries.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {entries.map(([path, msg]) => (
            <li key={path}>
              <a className="underline" href={`#${path.split(".").pop()}`}>{path.split(".").pop()}</a>: {msg}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
