// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeSearch, SEARCH_DEBOUNCE_MS, type EmployeeResult } from "@/ui/directory/EmployeeSearch";

const emp = (id: string, name: string, over: Partial<EmployeeResult> = {}): EmployeeResult => ({
  id, displayName: name, mail: `${name.split(" ")[0].toLowerCase()}@example.test`, userPrincipalName: `${id}@example.test`,
  employeeNumber: null, jobTitle: "Analyst", department: "Finance", officeLocation: "HQ", ...over,
});
const ok = (data: EmployeeResult[]) => new Response(JSON.stringify({ data }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => ok([]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const type = (text: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
const flush = async (ms = SEARCH_DEBOUNCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("EmployeeSearch", () => {
  it("debounces: rapid typing triggers one request, only after 250 ms", async () => {
    render(<EmployeeSearch onSelect={() => {}} />);
    type("ja");
    await flush(100);
    type("jan");
    await flush(100);
    type("jane");
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(SEARCH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await flush(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=jane");
  });

  it("does not search for fewer than 2 characters", async () => {
    render(<EmployeeSearch onSelect={() => {}} />);
    type("j");
    await flush(1000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows department, title, office and email for each option", async () => {
    fetchMock.mockResolvedValueOnce(ok([emp("a", "Jane Doe", { jobTitle: "Lead", department: "Legal", officeLocation: "Annex" })]));
    render(<EmployeeSearch onSelect={() => {}} />);
    type("jane");
    await flush();
    const option = screen.getByRole("option");
    expect(option.textContent).toContain("Jane Doe");
    expect(option.textContent).toContain("Lead · Legal · Annex");
    expect(option.textContent).toContain("jane@example.test");
  });

  it("navigates with the keyboard and selects with Enter", async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValueOnce(ok([emp("a", "Alice A"), emp("b", "Bob B"), emp("c", "Carl C")]));
    render(<EmployeeSearch onSelect={onSelect} />);
    type("al");
    await flush();
    const box = screen.getByRole("combobox");
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true"); // first result active by default
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2].id);
    fireEvent.keyDown(box, { key: "ArrowDown" }); // wraps
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowUp" }); // wraps back
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].id).toBe("c");
  });

  it("Escape closes the list; selecting by mouse works", async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValueOnce(ok([emp("a", "Alice A"), emp("b", "Bob B")]));
    render(<EmployeeSearch onSelect={onSelect} />);
    type("al");
    await flush();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.mouseDown(screen.getAllByRole("option")[1]);
    expect(onSelect.mock.calls[0][0].id).toBe("b");
  });

  it("explains an empty result and mentions the directory lookup", async () => {
    render(<EmployeeSearch onSelect={() => {}} />);
    type("zzz");
    await flush();
    expect(screen.getByRole("listbox").textContent).toContain("No matching employees");
    expect(screen.getByRole("listbox").textContent).toContain("directory");
  });

  it("reports rate limiting, permission and server errors in words", async () => {
    render(<EmployeeSearch onSelect={() => {}} />);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    type("aa");
    await flush();
    expect(screen.getByRole("listbox").textContent).toContain("Too many searches");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    type("ab");
    await flush();
    expect(screen.getByRole("listbox").textContent).toContain("permission");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    type("ac");
    await flush();
    expect(screen.getByRole("listbox").textContent).toContain("Search failed");
  });

  it("ignores a slow response for an older query (no stale results)", async () => {
    let resolveOld!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolveOld = r; }));
    fetchMock.mockResolvedValueOnce(ok([emp("new", "Newer Result")]));
    render(<EmployeeSearch onSelect={() => {}} />);
    type("old");
    await flush();
    type("newer");
    await flush();
    await act(async () => { resolveOld(ok([emp("old", "Stale Result")])); });
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names.join()).toContain("Newer Result");
    expect(names.join()).not.toContain("Stale Result");
  });

  it("clears the results when the query is shortened below 2 characters", async () => {
    fetchMock.mockResolvedValueOnce(ok([emp("a", "Alice A")]));
    render(<EmployeeSearch onSelect={() => {}} />);
    type("al");
    await flush();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    type("a");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
