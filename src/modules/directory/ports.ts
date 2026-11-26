// Directory port. The Graph adapter implements it in production; a fake implements it in tests only.

export interface DirectoryUser {
  oid: string;
  displayName: string;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  userPrincipalName: string;
  employeeNumber: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  accountEnabled: boolean;
  userType: string | null;
  employeeType: string | null;
  companyName: string | null;
}

export type DirectoryChange = { kind: "upsert"; user: DirectoryUser } | { kind: "removed"; oid: string };

export interface DeltaResult {
  changes: DirectoryChange[];
  /** Opaque cursor (Graph deltaLink) to pass to the next delta call. */
  cursor: string;
}

export interface DirectoryProvider {
  getUser(oid: string): Promise<DirectoryUser | null>;
  searchUsers(query: string, limit: number): Promise<DirectoryUser[]>;
  /** `cursor = null` enumerates every user (initial sync); otherwise returns only changes since the cursor. */
  delta(cursor: string | null): Promise<DeltaResult>;
  /** Object id of the user's manager, or null. Used by the full sync only. */
  getManagerOid(oid: string): Promise<string | null>;
}
