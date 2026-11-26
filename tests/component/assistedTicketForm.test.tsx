// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistedTicketForm } from "@/ui/tickets/AssistedTicketForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const JANE = { id: "22222222-2222-4222-8222-222222222222", displayName: "Jane Requester", mail: "jane@example.test", userPrincipalName: "jane@example.test", employeeNumber: null, jobTitle: "Accountant", department: "Finance", officeLocation: "HQ" };
const OMAR = { ...JANE, id: "33333333-3333-4333-8333-333333333333", displayName: "Omar Other", mail: "omar@example.test", jobTitle: "Engineer", department: "IT" };
const groups = [
  { id: "44444444-4444-4444-8444-444444444444", name: "Network", members: [{ id: "55555555-5555-4555-8555-555555555555", displayName: "Nina Network" }] },
  { id: "66666666-6666-4666-8666-666666666666", name: "Desktop", members: [{ id: "77777777-7777-4777-8777-777777777777", displayName: "Dan Desktop" }] },
];

type Call = { url: string; headers: Record<string, string>; body?: Record<string, unknown> };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit & { headers: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/directory/employees")) {
      const q = new URL(url, "http://x").searchParams.get("q")!.toLowerCase();
      const data = [JANE, OMAR].filter((e) => e.displayName.toLowerCase().includes(q));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { id: "t1", reference: "INC0000099" } }), { status: 201 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pick(user: ReturnType<typeof userEvent.setup>, query: string, name: string) {
  await user.type(screen.getByLabelText("Find the employee"), query);
  const option = await screen.findByRole("option", { name: new RegExp(name) }, { timeout: 2000 });
  fireEvent.mouseDown(option);
}
const fill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("Subject"), "Cannot print");
  await user.type(screen.getByLabelText("Description"), "Spooler is stuck.");
};
const submitCall = () => calls.find((c) => c.url === "/api/tickets/assisted");

describe("AssistedTicketForm (Form A)", () => {
  it("submits only the requester's id, never name/email/department snapshots", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride onCreated={onCreated} />);
    await pick(user, "jan", "Jane Requester");
    await fill(user);
    await user.click(screen.getByRole("button", { name: /create ticket/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("INC0000099"));

    const body = submitCall()!.body!;
    expect(body.requesterEmployeeId).toBe(JANE.id);
    expect(body.channel).toBe("phone");
    for (const k of ["requesterName", "requesterEmail", "requesterDepartment", "requesterJobTitle", "requesterLocation", "createdByEmployeeId", "role"]) expect(Object.keys(body)).not.toContain(k);
    expect(JSON.stringify(body)).not.toContain("jane@example.test");
    expect(submitCall()!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows the selected employee in a read-only card and 'Created by' for the agent", async () => {
    const user = userEvent.setup();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride />);
    await pick(user, "jan", "Jane Requester");
    const card = screen.getByTestId("requester-card");
    expect(card.textContent).toContain("Jane Requester");
    expect(card.textContent).toContain("Accountant");
    expect(card.querySelectorAll("input, select, textarea").length).toBe(0);
    expect(screen.getByText(/created by:/i).textContent).toContain("Alan Agent");
  });

  it("changing the selected employee clears the card and returns to search", async () => {
    const user = userEvent.setup();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride />);
    await pick(user, "jan", "Jane Requester");
    await user.click(screen.getByRole("button", { name: /choose a different employee/i }));
    expect(screen.queryByTestId("requester-card")).toBeNull();
    await pick(user, "oma", "Omar Other");
    expect(screen.getByTestId("requester-card").textContent).toContain("Omar Other");
    expect(screen.getByTestId("requester-card").textContent).not.toContain("Jane");
  });

  it("refuses to submit without a selected employee and sends nothing", async () => {
    const user = userEvent.setup();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: /create ticket/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Select the employee");
    expect(submitCall()).toBeUndefined();
  });

  it("filters the assignee list to the chosen group's members", async () => {
    const user = userEvent.setup();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride />);
    const assignee = screen.getByLabelText("Assignee (optional)") as HTMLSelectElement;
    expect(assignee.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Assignment group (optional)"), "Network");
    expect([...assignee.options].map((o) => o.text)).toEqual(["Unassigned", "Nina Network"]);
    await user.selectOptions(assignee, "Nina Network");
    await user.selectOptions(screen.getByLabelText("Assignment group (optional)"), "Desktop"); // changing the group resets the assignee
    expect(assignee.value).toBe("");
    expect([...assignee.options].map((o) => o.text)).toEqual(["Unassigned", "Dan Desktop"]);
  });

  it("sends a priority override with its reason only when enabled", async () => {
    const user = userEvent.setup();
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride onCreated={() => {}} />);
    await pick(user, "jan", "Jane Requester");
    await fill(user);
    await user.click(screen.getByLabelText(/override the calculated priority/i));
    await user.selectOptions(screen.getByLabelText("Priority"), "P1");
    await user.type(screen.getByLabelText("Reason for the override"), "Executive affected");
    await user.click(screen.getByRole("button", { name: /create ticket/i }));
    await waitFor(() => expect(submitCall()).toBeDefined());
    expect(submitCall()!.body!.priorityOverride).toEqual({ priority: "p1", reason: "Executive affected" });
  });

  it("hides override, group and assignee controls for roles that cannot use them (submitters)", () => {
    render(<AssistedTicketForm agentName="Sue Submitter" categories={[]} groups={[]} canOverride={false} />);
    expect(screen.queryByLabelText(/override the calculated priority/i)).toBeNull();
    expect(screen.queryByLabelText("Assignment group (optional)")).toBeNull();
    expect(screen.getByLabelText("How did the request arrive?")).toBeTruthy(); // channel remains
  });

  it("lists the employee's recent tickets, and never shows a previous selection's tickets after switching", async () => {
    const user = userEvent.setup();
    let release!: (v: { id: string; reference: string; subject: string; status: string }[]) => void;
    const loadRecent = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { release = r; })) // slow lookup for Jane
      .mockResolvedValueOnce([{ id: "o1", reference: "INC0000002", subject: "Omar laptop", status: "new" }]);
    render(<AssistedTicketForm agentName="Alan Agent" categories={[]} groups={groups} canOverride loadRecent={loadRecent} />);

    await pick(user, "jan", "Jane Requester");
    await user.click(screen.getByRole("button", { name: /choose a different employee/i }));
    await pick(user, "oma", "Omar Other");
    await screen.findByText(/Omar laptop/);

    await act(async () => { release([{ id: "j1", reference: "INC0000001", subject: "Jane VPN", status: "new" }]); });
    expect(screen.queryByText(/Jane VPN/)).toBeNull(); // the late answer for Jane is discarded
    expect(screen.getByLabelText("Recent tickets for this employee").textContent).toContain("Omar laptop");
  });
});
