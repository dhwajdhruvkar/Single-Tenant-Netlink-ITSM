// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPicker } from "@/ui/tickets/AttachmentPicker";
import { NewTicketForm } from "@/ui/tickets/NewTicketForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const file = (name: string, size = 10, type = "image/png") => new File([new Uint8Array(size)], name, { type });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let uploads: { url: string; method: string; name?: string }[];
let respond: (name: string) => Response | Promise<Response>;
let idN = 0;

beforeEach(() => {
  uploads = [];
  idN = 0;
  respond = () => json({ data: { id: `00000000-0000-4000-8000-${String(++idN).padStart(12, "0")}` } }, 201);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const name = init?.body instanceof FormData ? (init.body.get("file") as File).name : undefined;
    uploads.push({ url, method: init?.method ?? "GET", name });
    return init?.method === "DELETE" ? json({ data: { deleted: true } }) : respond(name ?? "");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pick = (...files: File[]) => fireEvent.change(screen.getByLabelText(/attachments/i), { target: { files } });

describe("AttachmentPicker", () => {
  it("uploads each file as its own request and reports the staged ids", async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker maxBytes={1000} onChange={onChange} />);
    pick(file("a.png"), file("b.png"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]));
    expect(uploads.filter((u) => u.method === "POST").map((u) => u.name)).toEqual(["a.png", "b.png"]);
    expect(screen.getAllByText("Uploaded")).toHaveLength(2);
  });

  it("reports busy while uploading and idle afterwards", async () => {
    const busy = vi.fn();
    let release!: () => void;
    respond = () => new Promise<Response>((r) => { release = () => r(json({ data: { id: "11111111-1111-4111-8111-111111111111" } }, 201)); });
    render(<AttachmentPicker maxBytes={1000} onChange={() => {}} onBusyChange={busy} />);
    pick(file("a.png"));
    expect(busy).toHaveBeenLastCalledWith(true);
    await act(async () => { release(); });
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });

  it("checks size client-side without uploading, and still shows the file with a reason", () => {
    render(<AttachmentPicker maxBytes={100} onChange={() => {}} />);
    pick(file("huge.png", 500));
    expect(screen.getByRole("alert").textContent).toContain("Larger than");
    expect(uploads).toHaveLength(0);
  });

  it("rejects empty files and more than the maximum count", () => {
    render(<AttachmentPicker maxBytes={1000} maxFiles={2} onChange={() => {}} />);
    pick(file("empty.png", 0));
    expect(screen.getAllByRole("alert")[0].textContent).toContain("empty");
    pick(file("a.png"), file("b.png"), file("c.png"));
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("At most 2"))).toBe(true);
    expect(uploads.filter((u) => u.method === "POST")).toHaveLength(2);
  });

  it("shows the server's reason for a rejected file and excludes it from the ids", async () => {
    const onChange = vi.fn();
    respond = () => json({ error: { code: "validation_error", message: "The file content does not match its type." } }, 400);
    render(<AttachmentPicker maxBytes={1000} onChange={onChange} />);
    pick(file("fake.pdf"));
    expect((await screen.findByRole("alert")).textContent).toContain("does not match its type");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("explains a 413 and a network failure", async () => {
    render(<AttachmentPicker maxBytes={1000} onChange={() => {}} />);
    respond = () => new Response("", { status: 413 });
    pick(file("a.png"));
    expect((await screen.findByRole("alert")).textContent).toContain("too large");
    respond = () => { throw new TypeError("offline"); };
    pick(file("b.png"));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("connection"))).toBe(true));
  });

  it("removing a file drops its id and asks the server to delete the staged upload", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AttachmentPicker maxBytes={1000} onChange={onChange} />);
    pick(file("a.png"));
    await screen.findByText("Uploaded");
    await user.click(screen.getByRole("button", { name: /remove a\.png/i }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(uploads.some((u) => u.method === "DELETE" && u.url.endsWith("00000000-0000-4000-8000-000000000001"))).toBe(true);
  });
});

describe("attachments in the self-service form", () => {
  const profile = { displayName: "Jane", mail: "j@example.test", department: null, jobTitle: null, officeLocation: null };

  it("sends the staged ids with the ticket, and still no requester fields", async () => {
    const user = userEvent.setup();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/attachments") return json({ data: { id: "22222222-2222-4222-8222-222222222222" } }, 201);
      bodies.push(JSON.parse(String(init?.body)));
      return json({ data: { id: "t", reference: "INC1" } }, 201);
    }));
    const onCreated = vi.fn();
    render(<NewTicketForm profile={profile} categories={[]} onCreated={onCreated} attachments={{ maxBytes: 4 * 1024 * 1024 }} />);
    await user.type(screen.getByLabelText("Subject"), "Screen broken");
    await user.type(screen.getByLabelText("Description"), "See screenshot");
    pick(file("shot.png"));
    await screen.findByText("Uploaded");
    await user.click(screen.getByRole("button", { name: /submit ticket/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(bodies[0].attachmentIds).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(Object.keys(bodies[0])).not.toContain("requesterEmployeeId");
  });

  it("disables submit while a file is still uploading", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = () => r(json({ data: { id: "33333333-3333-4333-8333-333333333333" } }, 201)); })));
    render(<NewTicketForm profile={profile} categories={[]} attachments={{ maxBytes: 1000 }} />);
    pick(file("slow.png"));
    const button = screen.getByRole("button", { name: /uploading files/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect((screen.getByRole("button", { name: /submit ticket/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("renders no attachment controls when the feature is switched off", () => {
    render(<NewTicketForm profile={profile} categories={[]} />);
    expect(screen.queryByLabelText(/attachments/i)).toBeNull();
  });
});
