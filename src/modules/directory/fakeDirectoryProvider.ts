// TEST DOUBLE ONLY. Never wired into production configuration (see src/platform/directory.ts).
import type { DeltaResult, DirectoryChange, DirectoryProvider, DirectoryUser } from "./ports";

export class FakeDirectoryProvider implements DirectoryProvider {
  users = new Map<string, DirectoryUser>();
  managers = new Map<string, string>();
  searchCalls: string[] = [];
  private pending: DirectoryChange[] = [];
  private version = 0;

  constructor(initial: DirectoryUser[] = []) {
    for (const u of initial) this.users.set(u.oid, u);
  }

  /** Queue a change to be returned by the next delta() call. */
  change(c: DirectoryChange) {
    if (c.kind === "upsert") this.users.set(c.user.oid, c.user);
    else this.users.delete(c.oid);
    this.pending.push(c);
  }

  async getUser(oid: string) {
    return this.users.get(oid) ?? null;
  }
  async searchUsers(query: string, limit: number) {
    this.searchCalls.push(query);
    const q = query.toLowerCase();
    return [...this.users.values()].filter((u) => `${u.displayName} ${u.mail ?? ""} ${u.userPrincipalName}`.toLowerCase().includes(q)).slice(0, limit);
  }
  async delta(cursor: string | null): Promise<DeltaResult> {
    this.version += 1;
    const changes: DirectoryChange[] = cursor === null ? [...this.users.values()].map((user) => ({ kind: "upsert" as const, user })) : this.pending;
    this.pending = [];
    return { changes, cursor: `https://graph.microsoft.com/v1.0/users/delta?$deltatoken=fake-${this.version}` };
  }
  async getManagerOid(oid: string) {
    return this.managers.get(oid) ?? null;
  }
}
