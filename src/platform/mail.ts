import { GraphClient } from "@/modules/directory/graph/graphClient";
import { getGraphToken } from "@/modules/directory/graph/token";
import { MailNotConfiguredError, type MailSender } from "@/modules/notifications/ports";
import { GraphMailSender } from "@/modules/notifications/providers/graphMailSender";
import { NoopMailSender } from "@/modules/notifications/providers/noopMailSender";
import { loadConfig } from "@/platform/config/env";

/** Composition root for outbound mail. `noop` is the default; `graph` needs Mail.Send scoped to SUPPORT_MAILBOX [EXTERNAL]. */
export function getMailSender(): MailSender {
  const cfg = loadConfig();
  switch (cfg.EMAIL_PROVIDER) {
    case "noop":
      return new NoopMailSender();
    case "graph": {
      const creds = { tenantId: cfg.GRAPH_TENANT_ID, clientId: cfg.GRAPH_CLIENT_ID, clientSecret: cfg.GRAPH_CLIENT_SECRET };
      return new GraphMailSender(new GraphClient({ getToken: () => getGraphToken(creds) }), cfg.SUPPORT_MAILBOX ?? "");
    }
    case "smtp":
      // Optional relay, only if company IT prefers SMTP over Graph [OPEN]; not implemented, so email jobs fail loudly instead of silently dropping mail.
      throw new MailNotConfiguredError("EMAIL_PROVIDER=smtp is not implemented. Use graph, or noop to disable email.");
  }
}
