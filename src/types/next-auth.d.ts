import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    uaid?: string;
    eid?: string;
    sv?: number;
  }
  interface Session {
    /** Server-side identity handles (ids only). Authorisation always re-reads the database. */
    claims?: { uaid: string; eid: string; sv: number };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uaid?: string;
    eid?: string;
    sv?: number;
  }
}
