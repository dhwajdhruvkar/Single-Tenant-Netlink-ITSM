// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActions, type AgentActionsProps } from "@/ui/tickets/AgentActions";
import { MessageComposer } from "@/ui/tickets/MessageComposer";
import { RequesterActions } from "@/ui/tickets/RequesterActions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: () => refresh() }) }));

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[];
let reply: (n: number) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  refresh.mockClear();
  reply = () => json({ data: { ok: true } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: JSON.parse(String(init.body ?? "{}")) });
    return reply(calls.length);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const GROUPS = [{ id: "g1", name: "Desk", members: [{ id: "m1", displayName: "Nina" }] }, { id: "g2", name: "Net", members: [{ id: "m2", displayName: "Omar" }] }];
const props = (over: Partial<AgentActionsProps> = {}): AgentActionsProps => ({
  reference: "INC0000042", version: 7, me: "me", statuses: ["in_progress", "on_hold", "resolved", "cancelled"], canAssign: true, canEdit: true, canArchive: false, groups: GROUPS,
  current: { groupId: "g1", assigneeId: null, priority: "p3", impact: "medium", urgency: "medium", priorityOverridden: false }, ...over,
});

describe("AgentActions", () => {
  it("sends the ticket version with every change and refreshes on success", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: "Start work" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: "/api/tickets/INC0000042/status", method: "POST", body: { version: 7, to: "in_progress" } });
  });

  it("only offers the statuses the server listed", () => {
    render(<AgentActions {...props({ statuses: ["closed"] })} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start work" })).toBeNull();
    expect(screen.queryByRole("button", { name: /put on hold/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resolve/i })).toBeNull();
  });

  it("shows 'no status changes' for final tickets and hides panels the server did not allow", () => {
    render(<AgentActions {...props({ statuses: [], canAssign: false, canEdit: false })} />);
    expect(screen.getByText(/no status changes/i)).toBeTruthy();
    expect(screen.queryByLabelText("Group")).toBeNull();
    expect(screen.queryByLabelText("Override priority")).toBeNull();
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("putting a ticket on hold requires choosing a reason, which is sent", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: /put on hold…/i }));
    await user.selectOptions(screen.getByLabelText("Why is it on hold?"), "awaiting_vendor");
    await user.click(screen.getByRole("button", { name: "Put on hold" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ version: 7, to: "on_hold", holdReason: "awaiting_vendor" });
  });

  it("resolving sends the optional code and notes only when filled in", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: /^resolve…/i }));
    await user.type(screen.getByLabelText(/what was done/i), "Replaced the cable.");
    await user.click(screen.getByRole("button", { name: "Resolve ticket" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ version: 7, to: "resolved", resolutionNotes: "Replaced the cable." });
  });

  it("'Assign to me' sends the literal \"me\" (the server resolves who that is)", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/tickets/INC0000042/assignment", body: { version: 7, assigneeEmployeeId: "me" } });
  });

  it("the assignee list follows the group, and saving sends only what changed", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    const person = screen.getByLabelText("Assignee") as HTMLSelectElement;
    expect([...person.options].map((o) => o.text)).toEqual(["Unassigned", "Nina"]);
    await user.selectOptions(screen.getByLabelText("Group"), "Net");
    expect([...person.options].map((o) => o.text)).toEqual(["Unassigned", "Omar"]);
    await user.selectOptions(person, "Omar");
    await user.click(screen.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ version: 7, groupId: "g2", assigneeEmployeeId: "m2" });
  });

  it("a priority override needs a reason before the button is enabled, then PATCHes with the version", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props()} />);
    const apply = screen.getByRole("button", { name: "Apply override" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Override priority"), "P1");
    await user.type(screen.getByLabelText("Reason (required)"), "Executive affected");
    expect(apply.disabled).toBe(false);
    await user.click(apply);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/tickets/INC0000042", method: "PATCH", body: { version: 7, priority: "p1", reason: "Executive affected" } });
  });

  it("a 409 STALE_VERSION tells the user someone else changed the ticket and reloads the page", async () => {
    const user = userEvent.setup();
    reply = () => json({ error: { code: "STALE_VERSION", message: "x" } }, 409);
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: "Start work" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/someone else changed this ticket/i);
    expect(refresh).toHaveBeenCalled();
  });

  it("other errors show the server's message and do not reload", async () => {
    const user = userEvent.setup();
    reply = () => json({ error: { code: "forbidden", message: "You do not have permission to do this." } }, 403);
    render(<AgentActions {...props()} />);
    await user.click(screen.getByRole("button", { name: "Start work" }));
    expect((await screen.findByRole("alert")).textContent).toContain("permission");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a second click while a request is in flight (no double change)", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => { calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) }); return new Promise<Response>((r) => { release = () => r(json({ data: {} })); }); }));
    render(<AgentActions {...props()} />);
    const b = screen.getByRole("button", { name: "Start work" });
    await user.click(b);
    await user.click(b);
    expect(calls).toHaveLength(1);
    release();
  });

  it("archive is offered only when allowed, with an optional reason", async () => {
    const user = userEvent.setup();
    render(<AgentActions {...props({ canArchive: true })} />);
    await user.type(screen.getByLabelText(/optional reason/i), "Duplicate of INC0000040");
    await user.click(screen.getByRole("button", { name: "Archive ticket" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/tickets/INC0000042/archive", body: { version: 7, reason: "Duplicate of INC0000040" } });
  });
});

describe("MessageComposer", () => {
  it("employees get a plain reply box with no internal-note control, and the body is sent as public", async () => {
    const user = userEvent.setup();
    render(<MessageComposer reference="INC0000042" version={3} canNote={false} />);
    expect(screen.queryByLabelText(/internal note/i)).toBeNull();
    await user.type(screen.getByLabelText("Reply"), "More details");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: "/api/tickets/INC0000042/messages", body: { body: "More details", visibility: "public", attachmentIds: [] } });
    expect(Object.keys(calls[0].body)).not.toContain("version"); // messages are not versioned
  });

  it("agents can switch to an internal note, which is labelled and sent as internal", async () => {
    const user = userEvent.setup();
    render(<MessageComposer reference="INC0000042" version={3} canNote />);
    await user.click(screen.getByLabelText(/internal note \(agents only\)/i));
    expect(screen.getByLabelText(/not visible to the requester/i)).toBeTruthy();
    await user.type(screen.getByLabelText(/not visible to the requester/i), "Escalate quietly");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({ visibility: "internal", body: "Escalate quietly" });
  });

  it("does not send an empty or whitespace-only message, and clears the box after sending", async () => {
    const user = userEvent.setup();
    render(<MessageComposer reference="INC0000042" version={3} canNote={false} />);
    const send = screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reply"), "   ");
    expect(send.disabled).toBe(true);
    await user.clear(screen.getByLabelText("Reply"));
    await user.type(screen.getByLabelText("Reply"), "hello");
    await user.click(send);
    await waitFor(() => expect((screen.getByLabelText("Reply") as HTMLTextAreaElement).value).toBe(""));
  });

  it("keeps the text when sending fails, and says why", async () => {
    const user = userEvent.setup();
    reply = () => json({ error: { code: "conflict", message: "This ticket is closed. Open a new ticket if you still need help." } }, 409);
    render(<MessageComposer reference="INC0000042" version={3} canNote={false} />);
    await user.type(screen.getByLabelText("Reply"), "Please reopen");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("closed");
    expect((screen.getByLabelText("Reply") as HTMLTextAreaElement).value).toBe("Please reopen");
  });
});

describe("RequesterActions", () => {
  it("renders nothing when the server offers no actions", () => {
    const { container } = render(<RequesterActions reference="INC1" version={1} statuses={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers confirm and reopen on a resolved ticket and sends the right status with the version", async () => {
    const user = userEvent.setup();
    render(<RequesterActions reference="INC1" version={4} statuses={["closed", "in_progress"]} />);
    await user.click(screen.getByRole("button", { name: /confirm it is resolved/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ version: 4, to: "closed" });
    await user.click(screen.getByRole("button", { name: /reopen/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ version: 4, to: "in_progress" });
  });

  it("cancelling asks for confirmation first", async () => {
    const user = userEvent.setup();
    render(<RequesterActions reference="INC1" version={0} statuses={["cancelled"]} />);
    await user.click(screen.getByRole("button", { name: "Cancel ticket" }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(screen.getByRole("button", { name: "Cancel ticket" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel ticket" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ version: 0, to: "cancelled" });
  });
});
