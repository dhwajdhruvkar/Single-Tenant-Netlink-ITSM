// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTicketForm } from "@/ui/tickets/NewTicketForm";
import { RequesterCard } from "@/ui/tickets/RequesterCard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const profile = { displayName: "Jane Doe", mail: "jane@example.test", department: "Finance", jobTitle: "Analyst", officeLocation: "HQ" };
const categories = [{ id: "11111111-1111-4111-8111-111111111111", name: "Network", ticketTypes: ["incident"] }, { id: "22222222-2222-4222-8222-222222222222", name: "Hardware", ticketTypes: ["service_request"] }];

type FetchCall = { url: string; init: RequestInit & { headers: Record<string, string> }; body: Record<string, unknown> };
let calls: FetchCall[];
let responder: (n: number) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  responder = () => new Response(JSON.stringify({ data: { id: "i1", reference: "INC0000042" } }), { status: 201 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return responder(calls.length);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, subject = "Cannot connect to VPN") {
  await user.type(screen.getByLabelText("Subject"), subject);
  await user.type(screen.getByLabelText("Description"), "Drops every hour.");
  await user.click(screen.getByRole("button", { name: /submit ticket/i }));
}

describe("RequesterCard", () => {
  it("is read-only: it renders text and contains no form controls", () => {
    const { container } = render(<RequesterCard profile={profile} />);
    expect(container.querySelectorAll("input, select, textarea, button").length).toBe(0);
    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("jane@example.test")).toBeTruthy();
    expect(screen.getByText("Finance")).toBeTruthy();
    expect(screen.getByText("Analyst")).toBeTruthy();
    expect(screen.getByText("HQ")).toBeTruthy();
  });
  it("shows a placeholder for every missing value", () => {
    render(<RequesterCard profile={{ displayName: "Sam", mail: null, department: null, jobTitle: null, officeLocation: null }} />);
    expect(screen.getAllByText("Not provided in directory")).toHaveLength(4);
  });
});

describe("NewTicketForm (Form B)", () => {
  it("renders the signed-in person's card and no hidden requester inputs", () => {
    const { container } = render(<NewTicketForm profile={profile} categories={categories} />);
    expect(screen.getByTestId("requester-card").textContent).toContain("Jane Doe");
    expect(container.querySelector("input[type=hidden]")).toBeNull();
    // nothing inside the card can be edited
    expect(screen.getByTestId("requester-card").querySelectorAll("input, select, textarea").length).toBe(0);
  });

  it("submits to the self-service endpoint with NO requester information in the request", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<NewTicketForm profile={profile} categories={categories} onCreated={onCreated} />);
    await fillAndSubmit(user);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("INC0000042"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/tickets/self");
    expect(calls[0].init.method).toBe("POST");
    const keys = Object.keys(calls[0].body);
    for (const k of ["requesterEmployeeId", "requesterName", "requesterEmail", "requesterDepartment", "createdBy", "role", "channel"]) expect(keys).not.toContain(k);
    expect(JSON.stringify(calls[0].body)).not.toContain("jane@example.test");
    expect(calls[0].body).toMatchObject({ type: "incident", subject: "Cannot connect to VPN", impact: "low", urgency: "medium" });
  });

  it("sends an Idempotency-Key, and a double click creates only one request", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    responder = () => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ data: { id: "i", reference: "INC1" } }), { status: 201 })); });
    render(<NewTicketForm profile={profile} categories={categories} onCreated={() => {}} />);
    await user.type(screen.getByLabelText("Subject"), "Printer jam");
    await user.type(screen.getByLabelText("Description"), "Paper stuck.");
    const button = screen.getByRole("button", { name: /submit ticket/i });
    await user.dblClick(button);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    release();
  });

  it("keeps the same key after a network error (safe retry) but issues a new one after a 4xx", async () => {
    const user = userEvent.setup();
    let mode: "network" | "invalid" | "ok" = "network";
    responder = () => {
      if (mode === "network") throw new TypeError("network down");
      if (mode === "invalid") return new Response(JSON.stringify({ error: { code: "validation_error", message: "The request is invalid.", details: { issues: [{ path: "subject", message: "Too short" }] } } }), { status: 400 });
      return new Response(JSON.stringify({ data: { id: "i", reference: "INC2" } }), { status: 201 });
    };
    const onCreated = vi.fn();
    render(<NewTicketForm profile={profile} categories={categories} onCreated={onCreated} />);
    await fillAndSubmit(user);
    await screen.findByText(/network error/i);

    mode = "invalid";
    await user.click(screen.getByRole("button", { name: /submit ticket/i }));
    await screen.findByText(/the request is invalid/i);
    expect(calls[1].init.headers["idempotency-key"]).toBe(calls[0].init.headers["idempotency-key"]); // retry after network error: same key

    mode = "ok";
    await user.click(screen.getByRole("button", { name: /submit ticket/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("INC2"));
    expect(calls[2].init.headers["idempotency-key"]).not.toBe(calls[1].init.headers["idempotency-key"]); // after a 4xx: new key
  });

  it("announces server validation errors in an alert with the field messages", async () => {
    const user = userEvent.setup();
    responder = () => new Response(JSON.stringify({ error: { code: "validation_error", message: "The request is invalid.", details: { issues: [{ path: "subject", message: "Too short" }] } } }), { status: 400 });
    render(<NewTicketForm profile={profile} categories={categories} />);
    await fillAndSubmit(user, "ab");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too short");
    expect(document.activeElement).toBe(alert);
    expect(screen.getByLabelText("Subject").getAttribute("aria-invalid")).toBe("true");
  });

  it("is operable by keyboard: Tab reaches the first control and Enter in a single-line field submits the form", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<NewTicketForm profile={profile} categories={categories} onCreated={onCreated} />);
    await user.tab();
    expect(document.activeElement?.getAttribute("name")).toBe("type"); // first control: the type radios
    await user.type(screen.getByLabelText("Description"), "No mouse needed");
    await user.type(screen.getByLabelText("Subject"), "Keyboard only{Enter}"); // Enter in the Subject input, no click
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("INC0000042"));
    expect(calls).toHaveLength(1);
  });

  it("every field has an associated label", () => {
    render(<NewTicketForm profile={profile} categories={categories} />);
    for (const label of ["Category", "Subject", "Description", "How many people are affected?", "Can you still work?", "Best phone number (optional)", "Where are you? (optional)"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("narrows categories by the chosen type and clears the selection when the type changes", async () => {
    const user = userEvent.setup();
    render(<NewTicketForm profile={profile} categories={categories} />);
    const select = screen.getByLabelText("Category") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Not sure / other", "Network"]);
    await user.selectOptions(select, "Network");
    await user.click(screen.getByLabelText("I need something"));
    expect([...(screen.getByLabelText("Category") as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Not sure / other", "Hardware"]);
    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByLabelText("How many people are affected?")).toBeNull();
    expect(screen.getByLabelText("What are you requesting? (optional)")).toBeTruthy();
  });
});
