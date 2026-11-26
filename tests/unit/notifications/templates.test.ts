import { describe, expect, it } from "vitest";
import { escapeHtml, excerpt, notificationContent, renderEmail, safeSubject, type NotificationKind } from "@/modules/notifications/templates";

const KINDS: NotificationKind[] = [
  "ticket_created", "ticket_logged_for", "ticket_logged_on_behalf", "ticket_assigned", "ticket_group_new", "message_public", "message_internal",
  "ticket_resolved", "ticket_awaiting_requester", "ticket_reopened", "ticket_closed", "ticket_cancelled", "sla_warning", "sla_breached", "sla_escalation",
];

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;"));
  it("is not fooled by pre-escaped input (no double-unescape)", () => expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;"));
});

describe("safeSubject", () => {
  it("removes CR/LF so a subject cannot inject mail headers", () => {
    const s = safeSubject("Hello\r\nBcc: attacker@evil.example\nX-Injected: 1");
    expect(s).not.toMatch(/[\r\n]/);
    expect(s).toBe("Hello Bcc: attacker@evil.example X-Injected: 1");
  });
  it("removes control characters and Unicode line/paragraph separators", () => {
    expect(safeSubject("a\u0000b\u0007c d e\u0085f")).toBe("a b c d e f");
  });
  it("collapses whitespace, trims, and bounds the length", () => {
    expect(safeSubject("  many   spaces \t here ")).toBe("many spaces here");
    expect(safeSubject("x".repeat(500)).length).toBe(150);
    expect(safeSubject("x".repeat(500), 20).endsWith("…")).toBe(true);
  });
});

describe("excerpt", () => {
  it("flattens whitespace and truncates", () => {
    expect(excerpt("a\n\n b   c")).toBe("a b c");
    expect(excerpt("y".repeat(400)).length).toBe(300);
  });
});

describe("notificationContent", () => {
  const ctx = { reference: "INC0000042", subject: "VPN keeps dropping", requesterName: "Jane Doe", actorName: "Alan Agent", messageExcerpt: "Have you tried restarting?", slaKind: "resolve" as const };

  it("every kind produces a non-empty title that names the ticket (or its person) and a body", () => {
    for (const k of KINDS) {
      const c = notificationContent(k, ctx);
      expect(c.title.length, k).toBeGreaterThan(5);
      expect(c.title + c.body, k).toMatch(/INC0000042|Jane Doe/);
    }
  });
  it("matches the wording for the launch events", () => {
    expect(notificationContent("ticket_created", ctx)).toEqual({ title: "We received your ticket INC0000042", body: '"VPN keeps dropping" has been logged. We will keep you updated here and by email.' });
    expect(notificationContent("ticket_logged_for", ctx).title).toBe("Ticket INC0000042 logged for Jane Doe");
    expect(notificationContent("ticket_logged_on_behalf", ctx).body).toBe('Alan Agent logged "VPN keeps dropping" on your behalf.');
    expect(notificationContent("ticket_resolved", ctx).body).toContain("confirm");
    expect(notificationContent("ticket_resolved", ctx).body).toContain("reopen");
    expect(notificationContent("message_public", ctx)).toEqual({ title: "New reply on INC0000042", body: "Alan Agent: Have you tried restarting?" });
  });
  it("an internal note's text never appears in its notification, whatever is passed in", () => {
    const c = notificationContent("message_internal", { ...ctx, messageExcerpt: "SECRET PLAN: fire everyone" });
    expect(JSON.stringify(c)).not.toContain("SECRET PLAN");
    expect(c.title).toBe("Internal note on INC0000042");
  });
  it("includes the SLA kind", () => {
    expect(notificationContent("sla_breached", { ...ctx, slaKind: "response" }).body).toContain("response");
    expect(notificationContent("sla_warning", ctx).body).toContain("resolve");
  });
  it("a hostile subject stays inside quotes as plain text and is flattened to one line", () => {
    const c = notificationContent("ticket_created", { ...ctx, subject: "x\r\nBcc: a@b.c" });
    expect(c.body).not.toMatch(/[\r\n]/);
  });
});

describe("renderEmail", () => {
  const base = { title: "We received your ticket INC0000042", body: 'Line one\nLine two', link: "https://itsm.example.test/my/tickets/INC0000042", reference: "INC0000042" };

  it("renders a stable HTML + text pair (snapshot)", () => {
    const m = renderEmail(base);
    expect(m.subject).toBe("We received your ticket INC0000042");
    expect(m.html).toMatchInlineSnapshot(`"<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#111;line-height:1.5"><h2 style="font-size:18px;margin:0 0 12px">We received your ticket INC0000042</h2><p style="margin:0 0 16px">Line one<br>Line two</p><p style="margin:0 0 16px"><a href="https://itsm.example.test/my/tickets/INC0000042" style="color:#1d4ed8">Open the ticket</a></p><p style="margin:24px 0 0;font-size:12px;color:#555">This is an automated message from Netlink IT support. Please do not reply to this email.</p></body></html>"`);
    expect(m.text).toMatchInlineSnapshot(`
      "We received your ticket INC0000042

      Line one
      Line two

      Open the ticket: https://itsm.example.test/my/tickets/INC0000042

      This is an automated message from Netlink IT support. Please do not reply to this email.
      "
    `);
  });

  it("escapes markup in the title, body and link: <script> in a subject cannot reach the HTML", () => {
    const m = renderEmail({ title: "Re: <script>alert(1)</script>", body: '"><img src=x onerror=alert(1)>', link: 'https://x.test/"><script>1</script>', reference: "INC1" });
    expect(m.html).not.toMatch(/<script|<img/i);
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(m.html).not.toContain('href="https://x.test/"><');
  });

  it("puts the reference in the subject when the title lacks it, and never duplicates it", () => {
    expect(renderEmail({ title: "New reply", body: "b", link: null, reference: "INC7" }).subject).toBe("[INC7] New reply");
    expect(renderEmail({ title: "INC7 resolved", body: "b", link: null, reference: "INC7" }).subject).toBe("INC7 resolved");
  });

  it("the subject is always one safe line, even for a hostile title", () => {
    expect(renderEmail({ title: "Hi\r\nBcc: x@y.z", body: "b", link: null }).subject).not.toMatch(/[\r\n]/);
  });

  it("has no remote resources, scripts or tracking, and omits the link block when there is no link", () => {
    const m = renderEmail({ title: "t", body: "b", link: null });
    expect(m.html).not.toMatch(/<img|<script|<link|src=|url\(/i);
    expect(m.html).not.toContain("Open the ticket");
    expect(m.text).not.toContain("Open the ticket");
  });
});
