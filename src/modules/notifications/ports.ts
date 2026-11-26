// Outbound mail port. Core logic never imports a mail SDK; providers live in ./providers and are chosen by EMAIL_PROVIDER.

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailSender {
  readonly provider: "noop" | "graph" | "smtp";
  /** Throws on failure so the job runner can retry with backoff. */
  send(mail: OutboundEmail): Promise<void>;
}

export class MailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailNotConfiguredError";
  }
}
