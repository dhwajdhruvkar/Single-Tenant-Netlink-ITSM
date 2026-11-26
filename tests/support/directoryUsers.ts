import { randomUUID } from "node:crypto";
import type { DirectoryUser } from "@/modules/directory/ports";

export function dirUser(over: Partial<DirectoryUser> = {}): DirectoryUser {
  const n = Math.floor(Math.random() * 1e9);
  return {
    oid: randomUUID(),
    displayName: `Person ${n}`,
    givenName: "Person",
    surname: String(n),
    mail: `person${n}@example.test`,
    userPrincipalName: `person${n}@example.test`,
    employeeNumber: null,
    jobTitle: "Analyst",
    department: "Finance",
    officeLocation: "HQ",
    businessPhone: null,
    mobilePhone: null,
    accountEnabled: true,
    userType: "Member",
    employeeType: null,
    companyName: null,
    ...over,
  };
}
