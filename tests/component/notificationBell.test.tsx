// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell, BELL_POLL_MS } from "@/ui/notifications/NotificationBell";

vi.mock("next/link", () => ({ default: ({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) => <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(); }}>{children}</a> }));

const item = (id: string, title: string, read = false) => ({ id, type: "x", title, body: `body of ${title}`, link: `/my/tickets/INC${id}`, read, createdAt: "2026-03-04T12:00:00.000Z" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let calls: { url: string; method: string; body?: unknown }[];
let list: () => Response;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  list = () => json({ data: [item("1", "First ticket reply"), item("2", "Resolved", true)], meta: { unread: 1 } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return url.startsWith("/api/notifications/read") ? json({ data: { updated: 1 } }) : list();
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const loaded = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5); }); };

describe("NotificationBell", () => {
  it("shows the unread count in an accessible label", async () => {
    render(<NotificationBell />);
    await loaded();
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
  });

  it("renders nothing for a signed-out visitor (401) so the shared shell stays clean", async () => {
    list = () => json({ error: { code: "unauthenticated" } }, 401);
    const { container } = render(<NotificationBell />);
    await loaded();
    expect(container.firstChild).toBeNull();
  });

  it("opens a list, marks unread items, links to the ticket", async () => {
    render(<NotificationBell />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByRole("link", { name: "First ticket reply" }).getAttribute("href")).toBe("/my/tickets/INC1");
    expect(screen.getByText(/unread/)).toBeTruthy();
    expect(screen.getByText("body of First ticket reply")).toBeTruthy();
  });

  it("clicking a notification marks just that one read and refreshes", async () => {
    render(<NotificationBell />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    list = () => json({ data: [item("1", "First ticket reply", true), item("2", "Resolved", true)], meta: { unread: 0 } });
    fireEvent.click(screen.getByRole("link", { name: "First ticket reply" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/notifications/read" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.url === "/api/notifications/read")!.body).toEqual({ ids: ["1"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 0 unread" })).toBeTruthy());
  });

  it("'Mark all read' sends { all: true }", async () => {
    render(<NotificationBell />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(calls.some((c) => c.body && (c.body as { all?: boolean }).all === true)).toBe(true));
  });

  it("polls every 60 seconds", async () => {
    render(<NotificationBell />);
    await loaded();
    const before = calls.filter((c) => c.url.startsWith("/api/notifications?")).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(BELL_POLL_MS); });
    expect(calls.filter((c) => c.url.startsWith("/api/notifications?")).length).toBe(before + 1);
    expect(BELL_POLL_MS).toBe(60_000);
  });

  it("does not poll while the tab is hidden", async () => {
    render(<NotificationBell />);
    await loaded();
    const before = calls.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(BELL_POLL_MS * 3); });
    expect(calls.length).toBe(before);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("stops polling after unmount", async () => {
    const { unmount } = render(<NotificationBell />);
    await loaded();
    unmount();
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(BELL_POLL_MS * 3); });
    expect(calls.length).toBe(before);
  });

  it("shows the last known list and a message when a refresh fails", async () => {
    render(<NotificationBell />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    list = () => { throw new TypeError("offline"); };
    await act(async () => { await vi.advanceTimersByTimeAsync(BELL_POLL_MS); });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not refresh");
    expect(screen.getByRole("link", { name: "First ticket reply" })).toBeTruthy();
  });

  it("says so when there is nothing", async () => {
    list = () => json({ data: [], meta: { unread: 0 } });
    render(<NotificationBell />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText("No notifications.")).toBeTruthy();
  });

  it("caps a huge unread count at 99+", async () => {
    list = () => json({ data: [item("1", "x")], meta: { unread: 250 } });
    render(<NotificationBell />);
    await loaded();
    expect(screen.getByText("99+")).toBeTruthy();
  });
});
