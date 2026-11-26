// Append-only audit trail (security/compliance). Never write secrets, tokens or attachment bytes into `changes`.

export interface AuditEntry {
  action: string; // auth.signin, auth.signin_denied, auth.signout, ticket.create, role.grant, ...
  actorType: "user" | "system" | "job";
  actorEmployeeId?: string | null;
  entityType: string;
  entityId?: string | null;
  ticketId?: string | null;
  requestId?: string | null;
  changes?: Record<string, unknown> | null;
}

interface AuditClient {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/** Pass a transaction client so the audit row commits atomically with the change it describes. */
export async function writeAudit(db: AuditClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      actorType: entry.actorType,
      actorEmployeeId: entry.actorEmployeeId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ticketId: entry.ticketId ?? null,
      requestId: entry.requestId ?? null,
      changes: (entry.changes as never) ?? undefined,
    },
  });
}
