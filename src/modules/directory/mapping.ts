import type { DirectoryUser } from "./ports";

// Pure mapping of a directory user onto Employee columns. Missing attributes become null; nothing is guessed.

export interface EmployeeFields {
  userPrincipalName: string;
  mail: string | null;
  displayName: string;
  givenName: string | null;
  surname: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  departmentRaw: string | null;
  officeLocationRaw: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  accountEnabled: boolean;
}

function clean(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function mapDirectoryUser(user: DirectoryUser): EmployeeFields {
  const upn = clean(user.userPrincipalName) ?? "";
  return {
    userPrincipalName: upn,
    mail: clean(user.mail),
    displayName: clean(user.displayName) ?? upn,
    givenName: clean(user.givenName),
    surname: clean(user.surname),
    employeeNumber: clean(user.employeeNumber),
    jobTitle: clean(user.jobTitle),
    departmentRaw: clean(user.department),
    officeLocationRaw: clean(user.officeLocation),
    businessPhone: clean(user.businessPhone),
    mobilePhone: clean(user.mobilePhone),
    accountEnabled: user.accountEnabled,
  };
}
