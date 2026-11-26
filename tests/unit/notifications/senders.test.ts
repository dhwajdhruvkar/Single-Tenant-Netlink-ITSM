import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "@/modules/directory/graph/graphClient";
import { MailNotConfiguredError } from "@/modules/notifications/ports";
import { GraphMailSender } from "@/modules/notifications/providers/graphMailSender";
import { NoopMailSender } from "@/modules/notifications/providers/noopMailSender";
import { parseConfig } from "@/platform/config/env";
import { MarkRead } from "@/modules/notifications/inbox";

const mail = { to: "jane@example.test", subject: "Hello", html: "<p>Hi</p>", text: "Hi" };

describe("GraphMailSender", () => {
  it("POSTs the documented sendMail payload for the support mailbox, without saving to Sent Items", async () => {
    const post = vi.fn(async () => 202);
    await new GraphMailSender({ post }, "support@example.test").send(mail);
    expect(post).toHaveBeenCalledWith("/users/support%40example.test/sendMail", {
      message: { subject: "Hello", body: { contentType: "HTML", content: "<p>Hi</p>" }, toRecipients: [{ emailAddress: { address: "jane@example.test" } }] },
      saveToSentItems: false,
    });
  });

  it("refuses a malformed support mailbox at construction and a malformed recipient at send time", async () => {
    expect(() => new GraphMailSender({ post: vi.fn() }, "not-an-email")).toThrow(MailNotConfiguredError);
    expect(() => new GraphMailSender({ post: vi.fn() }, "a@b.c/../../users/ceo@x.y")).toThrow();
    const post = vi.fn();
    const s = new GraphMailSender({ post }, "support@example.test");
    for (const bad of ["no-at-sign", "a@b", "x@y.z, evil@e.vil", 'a"b@c.d', "a b@c.d", "<a@b.c>"]) await expect(s.send({ ...mail, to: bad }), bad).rejects.toThrow(/malformed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("throws when Graph rejects, so the job runner retries", async () => {
    const post = vi.fn(async () => { throw new Error("Graph request failed (403)"); });
    await expect(new GraphMailSender({ post }, "support@example.test").send(mail)).rejects.toThrow(/403/);
  });

  it("through the real client: sends a bearer token and retries a 429 after Retry-After", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const responses = [new Response("", { status: 429, headers: { "retry-after": "3" } }), new Response("", { status: 202 })];
    const sleeps: number[] = [];
    const graph = new GraphClient({
      getToken: async () => "tok",
      fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await new GraphMailSender(graph, "support@example.test").send(mail);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/users/support%40example.test/sendMail");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body)).message.toRecipients[0].emailAddress.address).toBe("jane@example.test");
  });
});

describe("NoopMailSender", () => {
  it("sends nothing and does not log the recipient address, subject or body", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await new NoopMailSender().send({ ...mail, subject: "Secret subject", text: "Secret body" });
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("example.test");
    for (const leak of ["jane@", "Secret subject", "Secret body"]) expect(out).not.toContain(leak);
    spy.mockRestore();
  });
});

describe("EMAIL_PROVIDER configuration", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/d" };
  it("noop (the default) needs nothing", () => expect(parseConfig(base).EMAIL_PROVIDER).toBe("noop"));
  it("graph needs a valid support mailbox and the Graph app credentials", () => {
    expect(() => parseConfig({ ...base, EMAIL_PROVIDER: "graph" })).toThrow(/SUPPORT_MAILBOX[\s\S]*GRAPH_TENANT_ID[\s\S]*GRAPH_CLIENT_ID[\s\S]*GRAPH_CLIENT_SECRET/);
    expect(() => parseConfig({ ...base, EMAIL_PROVIDER: "graph", SUPPORT_MAILBOX: "nope", GRAPH_TENANT_ID: "11111111-1111-1111-1111-111111111111", GRAPH_CLIENT_ID: "22222222-2222-2222-2222-222222222222", GRAPH_CLIENT_SECRET: "x" })).toThrow(/SUPPORT_MAILBOX/);
    expect(parseConfig({ ...base, EMAIL_PROVIDER: "graph", SUPPORT_MAILBOX: "support@example.test", GRAPH_TENANT_ID: "11111111-1111-1111-1111-111111111111", GRAPH_CLIENT_ID: "22222222-2222-2222-2222-222222222222", GRAPH_CLIENT_SECRET: "x" }).EMAIL_PROVIDER).toBe("graph");
  });
});

describe("MarkRead contract", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("accepts exactly one of ids / all", () => {
    expect(MarkRead.safeParse({ ids: [id] }).success).toBe(true);
    expect(MarkRead.safeParse({ all: true }).success).toBe(true);
    for (const bad of [{}, { ids: [] }, { ids: [id], all: true }, { all: false }, { ids: ["nope"] }, { ids: [id], extra: 1 }]) expect(MarkRead.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
