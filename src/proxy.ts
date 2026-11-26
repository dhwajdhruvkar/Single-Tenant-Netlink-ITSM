import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Next.js 16 proxy (formerly middleware). Edge-safe: it only checks that a session exists. Full account validation
// (active, session version, role) happens in requireActor() on every API call.
export const proxy = NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
