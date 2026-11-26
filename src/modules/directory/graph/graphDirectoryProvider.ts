import { isGuid } from "@/modules/identity/claims";
import type { DeltaResult, DirectoryChange, DirectoryProvider, DirectoryUser } from "../ports";
import { assertGraphUrl, GraphClient } from "./graphClient";

const SELECT =
  "id,displayName,givenName,surname,mail,userPrincipalName,employeeId,jobTitle,department,officeLocation,businessPhones,mobilePhone,accountEnabled,userType,employeeType,companyName";

interface GraphUser {
  id?: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  employeeId?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  businessPhones?: string[] | null;
  mobilePhone?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  employeeType?: string | null;
  companyName?: string | null;
  "@removed"?: { reason?: string };
}

interface GraphPage {
  value: GraphUser[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export function fromGraphUser(u: GraphUser): DirectoryUser | null {
  if (!u.id || !isGuid(u.id) || !u.userPrincipalName) return null;
  return {
    oid: u.id.toLowerCase(),
    displayName: u.displayName ?? u.userPrincipalName,
    givenName: u.givenName ?? null,
    surname: u.surname ?? null,
    mail: u.mail ?? null,
    userPrincipalName: u.userPrincipalName,
    employeeNumber: u.employeeId ?? null,
    jobTitle: u.jobTitle ?? null,
    department: u.department ?? null,
    officeLocation: u.officeLocation ?? null,
    businessPhone: u.businessPhones?.[0] ?? null,
    mobilePhone: u.mobilePhone ?? null,
    // Graph omits accountEnabled when it was not requested/changed in a delta; absent means "unchanged enabled" for new rows.
    accountEnabled: u.accountEnabled !== false,
    userType: u.userType ?? null,
    employeeType: u.employeeType ?? null,
    companyName: u.companyName ?? null,
  };
}

/** Strip characters that could break out of a $search clause. */
export function sanitizeSearchTerm(q: string): string {
  return q.replace(/["\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
}

export class GraphDirectoryProvider implements DirectoryProvider {
  constructor(private readonly graph: GraphClient) {}

  async getUser(oid: string): Promise<DirectoryUser | null> {
    if (!isGuid(oid)) return null;
    const u = await this.graph.get<GraphUser>(`/users/${oid}?$select=${SELECT}`);
    return u ? fromGraphUser(u) : null;
  }

  async searchUsers(query: string, limit: number): Promise<DirectoryUser[]> {
    const q = sanitizeSearchTerm(query);
    if (q.length < 2) return [];
    const search = encodeURIComponent(`"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`);
    const page = await this.graph.get<GraphPage>(`/users?$search=${search}&$top=${Math.min(Math.max(limit, 1), 25)}&$select=${SELECT}`, {
      ConsistencyLevel: "eventual",
    });
    return (page?.value ?? []).map(fromGraphUser).filter((u): u is DirectoryUser => u !== null);
  }

  async delta(cursor: string | null): Promise<DeltaResult> {
    let url: string = cursor ? assertGraphUrl(cursor) : `/users/delta?$select=${SELECT}`;
    const changes: DirectoryChange[] = [];
    // Bounded page loop so a misbehaving response cannot spin forever.
    for (let pages = 0; pages < 1000; pages++) {
      const page = await this.graph.get<GraphPage>(url);
      if (!page) throw new Error("Graph delta returned 404");
      for (const item of page.value) {
        if (item["@removed"]) {
          if (item.id && isGuid(item.id)) changes.push({ kind: "removed", oid: item.id.toLowerCase() });
          continue;
        }
        const user = fromGraphUser(item);
        if (user) changes.push({ kind: "upsert", user });
      }
      if (page["@odata.nextLink"]) {
        url = assertGraphUrl(page["@odata.nextLink"]);
        continue;
      }
      if (page["@odata.deltaLink"]) return { changes, cursor: assertGraphUrl(page["@odata.deltaLink"]) };
      throw new Error("Graph delta response had neither nextLink nor deltaLink");
    }
    throw new Error("Graph delta exceeded the page limit");
  }

  async getManagerOid(oid: string): Promise<string | null> {
    if (!isGuid(oid)) return null;
    const m = await this.graph.get<{ id?: string }>(`/users/${oid}/manager?$select=id`);
    return m?.id && isGuid(m.id) ? m.id.toLowerCase() : null;
  }
}
