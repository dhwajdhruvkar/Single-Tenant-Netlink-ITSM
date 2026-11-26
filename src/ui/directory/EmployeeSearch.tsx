"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface EmployeeResult {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  employeeNumber: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
}

export const SEARCH_DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

type State = { kind: "idle" } | { kind: "loading" } | { kind: "results"; items: EmployeeResult[] } | { kind: "error"; message: string };

/**
 * Employee picker for the assisted form: 250 ms debounce, ARIA combobox with keyboard navigation (Up/Down/Enter/Escape),
 * and department/title/office on each option. It only ever returns an employee id and display data for the read-only card.
 */
export function EmployeeSearch({ onSelect, searchUrl = "/api/directory/employees" }: { onSelect: (e: EmployeeResult) => void; searchUrl?: string }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  const trimmed = query.trim();
  const tooShort = trimmed.length < MIN_CHARS;

  useEffect(() => {
    if (tooShort) {
      seq.current += 1; // invalidate anything still in flight
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const res = await fetch(`${searchUrl}?q=${encodeURIComponent(trimmed)}&limit=10`);
        if (id !== seq.current) return; // a newer query superseded this one
        if (res.status === 429) return setState({ kind: "error", message: "Too many searches. Wait a moment and try again." });
        if (res.status === 403) return setState({ kind: "error", message: "You do not have permission to search employees." });
        if (!res.ok) return setState({ kind: "error", message: "Search failed. Try again." });
        const body = (await res.json()) as { data: EmployeeResult[] };
        if (id !== seq.current) return;
        setState({ kind: "results", items: body.data });
        setActive(body.data.length > 0 ? 0 : -1);
      } catch {
        if (id === seq.current) setState({ kind: "error", message: "Search failed. Check your connection." });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, tooShort, searchUrl]);

  // Short queries show nothing, whatever the last search left in state.
  const shown: State = tooShort ? { kind: "idle" } : state;
  const items = shown.kind === "results" ? shown.items : [];

  function choose(e: EmployeeResult) {
    setOpen(false);
    setQuery("");
    setState({ kind: "idle" });
    onSelect(e);
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setOpen(true);
      setActive((i) => (items.length === 0 ? -1 : (i + 1) % items.length));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((i) => (items.length === 0 ? -1 : (i - 1 + items.length) % items.length));
    } else if (ev.key === "Enter" && open && active >= 0 && items[active]) {
      ev.preventDefault();
      choose(items[active]);
    } else if (ev.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="block text-sm font-medium text-gray-800">Find the employee</label>
      <input
        id={`${listId}-input`}
        role="combobox"
        aria-expanded={open && shown.kind !== "idle"}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
        autoComplete="off"
        className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        placeholder="Name, email or employee number"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <div aria-live="polite" className="text-xs text-gray-500">
        {shown.kind === "loading" ? "Searching…" : shown.kind === "results" ? `${items.length} result${items.length === 1 ? "" : "s"}` : ""}
      </div>
      {open && shown.kind !== "idle" ? (
        <ul id={listId} role="listbox" className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow">
          {shown.kind === "error" ? <li className="px-3 py-2 text-sm text-red-700">{shown.message}</li> : null}
          {shown.kind === "results" && items.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-600">No matching employees. New people are looked up in the company directory automatically, so check the spelling.</li>
          ) : null}
          {items.map((e, i) => (
            <li
              key={e.id}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-blue-50" : ""}`}
              onMouseDown={(ev) => { ev.preventDefault(); choose(e); }}
              onMouseEnter={() => setActive(i)}
            >
              <div className="font-medium text-gray-900">{e.displayName}</div>
              <div className="text-xs text-gray-600">{[e.jobTitle, e.department, e.officeLocation].filter(Boolean).join(" · ") || "No department or title in directory"}</div>
              <div className="text-xs text-gray-500">{e.mail ?? e.userPrincipalName}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
