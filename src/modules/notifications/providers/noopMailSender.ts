import { logger } from "@/platform/logging/logger";
import type { MailSender, OutboundEmail } from "../ports";

/** Default for local development: nothing is sent. Logs the fact (not the content) so a missing mail provider is visible. */
export class NoopMailSender implements MailSender {
  readonly provider = "noop" as const;
  async send(mail: OutboundEmail): Promise<void> {
    logger.info("email not sent (EMAIL_PROVIDER=noop)", { toDomain: mail.to.split("@")[1] ?? "unknown", subjectLength: mail.subject.length });
  }
}
