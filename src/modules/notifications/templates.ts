// Notification content and email rendering. Everything that comes from users (subjects, names, reply text) is HTML-escaped, and
// subjects are stripped of line breaks, so ticket content can never inject markup or mail headers.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// C0/C1 controls plus Unicode line and paragraph separators. Built from a string so the escapes stay escapes.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+", "g");

/** One line, no control characters, bounded length: safe for a Subject header. */
export function safeSubject(value: string, max = 150): string {
  const oneLine = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function excerpt(value: string, max = 300): string {
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type NotificationKind =
  | "ticket_created" | "ticket_logged_for" | "ticket_logged_on_behalf"
  | "ticket_assigned" | "ticket_group_new"
  | "message_public" | "message_internal"
  | "ticket_resolved" | "ticket_awaiting_requester" | "ticket_reopened" | "ticket_closed" | "ticket_cancelled"
  | "sla_warning" | "sla_breached" | "sla_escalation";

export interface ContentCtx {
  reference: string;
  subject: string;
  /** requester's display name, for "logged for Jane" */
  requesterName?: string;
  /** who did it, when known and relevant */
  actorName?: string;
  messageExcerpt?: string;
  slaKind?: "response" | "resolve";
}

export interface NotificationContent {
  title: string;
  body: string;
}

export function notificationContent(kind: NotificationKind, c: ContentCtx): NotificationContent {
  const ref = c.reference;
  const subj = safeSubject(c.subject, 120);
  switch (kind) {
    case "ticket_created": return { title: `We received your ticket ${ref}`, body: `"${subj}" has been logged. We will keep you updated here and by email.` };
    case "ticket_logged_on_behalf": return { title: `A ticket ${ref} was logged for you`, body: `${c.actorName ?? "A service desk agent"} logged "${subj}" on your behalf.` };
    case "ticket_logged_for": return { title: `Ticket ${ref} logged for ${c.requesterName ?? "the requester"}`, body: `You logged "${subj}".` };
    case "ticket_assigned": return { title: `${ref} was assigned to you`, body: `"${subj}"${c.requesterName ? ` from ${c.requesterName}` : ""}.` };
    case "ticket_group_new": return { title: `New ticket ${ref} in your group`, body: `"${subj}"${c.requesterName ? ` from ${c.requesterName}` : ""} is waiting to be picked up.` };
    case "message_public": return { title: `New reply on ${ref}`, body: `${c.actorName ? `${c.actorName}: ` : ""}${c.messageExcerpt ?? ""}`.trim() };
    // The body of an internal note is never copied into a notification (or an email).
    case "message_internal": return { title: `Internal note on ${ref}`, body: `${c.actorName ?? "A colleague"} added an internal note to "${subj}".` };
    case "ticket_resolved": return { title: `${ref} has been resolved`, body: `"${subj}" was marked resolved. Please confirm that it is fixed, or reopen it if it is not.` };
    case "ticket_awaiting_requester": return { title: `${ref} is waiting for your reply`, body: `We need more information on "${subj}" before we can continue.` };
    case "ticket_reopened": return { title: `${ref} was reopened`, body: `"${subj}" was reopened by the requester.` };
    case "ticket_closed": return { title: `${ref} has been closed`, body: `"${subj}" was closed. Open a new ticket if you still need help.` };
    case "ticket_cancelled": return { title: `${ref} was cancelled`, body: `"${subj}" was cancelled.` };
    case "sla_warning": return { title: `SLA warning on ${ref}`, body: `The ${c.slaKind ?? "resolution"} target for "${subj}" is almost reached.` };
    case "sla_breached": return { title: `SLA breached on ${ref}`, body: `The ${c.slaKind ?? "resolution"} target for "${subj}" has passed.` };
    case "sla_escalation": return { title: `Escalation: ${ref} breached its SLA`, body: `The ${c.slaKind ?? "resolution"} target for "${subj}" has passed and the ticket needs attention.` };
  }
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Plain, inline-styled HTML (no remote images, no scripts) plus a text alternative. `link` must already be an absolute URL built from APP_BASE_URL. */
export function renderEmail(input: { title: string; body: string; link: string | null; reference?: string }): RenderedEmail {
  const subject = safeSubject(input.reference && !input.title.includes(input.reference) ? `[${input.reference}] ${input.title}` : input.title);
  const t = escapeHtml(input.title);
  const b = escapeHtml(input.body).replace(/\n/g, "<br>");
  const l = input.link ? escapeHtml(input.link) : null;
  const html =
    `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#111;line-height:1.5">` +
    `<h2 style="font-size:18px;margin:0 0 12px">${t}</h2>` +
    `<p style="margin:0 0 16px">${b}</p>` +
    (l ? `<p style="margin:0 0 16px"><a href="${l}" style="color:#1d4ed8">Open the ticket</a></p>` : "") +
    `<p style="margin:24px 0 0;font-size:12px;color:#555">This is an automated message from Netlink IT support. Please do not reply to this email.</p>` +
    `</body></html>`;
  const text = `${input.title}\n\n${input.body}\n${input.link ? `\nOpen the ticket: ${input.link}\n` : ""}\nThis is an automated message from Netlink IT support. Please do not reply to this email.\n`;
  return { subject, html, text };
}
