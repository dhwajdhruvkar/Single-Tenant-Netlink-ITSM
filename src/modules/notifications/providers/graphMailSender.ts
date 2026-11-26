import type { GraphClient } from "@/modules/directory/graph/graphClient";
import { MailNotConfiguredError, type MailSender, type OutboundEmail } from "../ports";

// Sends through Microsoft Graph `POST /users/{SUPPORT_MAILBOX}/sendMail` using the app-only (client-credentials) token.
// Needs the application permission Mail.Send, which MUST be restricted to the support mailbox with Exchange RBAC for Applications
// (or an Application Access Policy) by company IT [EXTERNAL]; otherwise the permission allows sending as any mailbox.

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export class GraphMailSender implements MailSender {
  readonly provider = "graph" as const;

  constructor(private readonly graph: Pick<GraphClient, "post">, private readonly mailbox: string) {
    if (!EMAIL.test(mailbox)) throw new MailNotConfiguredError("SUPPORT_MAILBOX must be an email address.");
  }

  async send(mail: OutboundEmail): Promise<void> {
    if (!EMAIL.test(mail.to)) throw new Error("Refusing to send to a malformed address.");
    await this.graph.post(`/users/${encodeURIComponent(this.mailbox)}/sendMail`, {
      message: {
        subject: mail.subject,
        body: { contentType: "HTML", content: mail.html },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      },
      saveToSentItems: false,
    });
  }
}
