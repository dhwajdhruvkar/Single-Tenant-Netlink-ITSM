import type { AppRole } from "./roleMapping";

/** The authenticated principal for one request. Built only from the server-side session and database, never from client input. */
export interface Actor {
  employeeId: string;
  userAccountId: string;
  role: AppRole;
  /** Assignment groups the actor belongs to (loaded for agent+ only). */
  groupIds: readonly string[];
  /** Subset of groupIds that are triage groups. */
  triageGroupIds: readonly string[];
}
