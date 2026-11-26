import type { NextAuthConfig } from "next-auth";

// Edge-safe part of the Auth.js config (no database, no Node-only imports). Used by the proxy.
// There is deliberately NO Credentials/demo/local-password provider anywhere in this application.

const PUBLIC_PREFIXES = ["/signin", "/access-denied", "/api/auth", "/api/health", "/api/ready", "/api/internal/jobs/run", "/_next", "/favicon"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || (p === "/favicon" && pathname.startsWith(p)));
}

export const authConfig = {
  pages: { signIn: "/signin", error: "/access-denied" },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    // jwt/session are pure (no database) so the proxy sees the same claims as the server. Keep the JWT minimal.
    async jwt({ token, user }) {
      if (user?.uaid) return { uaid: user.uaid, eid: user.eid, sv: user.sv };
      return token;
    },
    async session({ session, token }) {
      if (token.uaid && token.eid && typeof token.sv === "number") {
        session.claims = { uaid: token.uaid, eid: token.eid, sv: token.sv };
      }
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (isPublicPath(pathname)) return true;
      if (auth?.claims) return true;
      if (pathname.startsWith("/api/")) {
        return Response.json({ error: { code: "unauthenticated", message: "Authentication is required." } }, { status: 401 });
      }
      return false; // pages: Auth.js redirects to /signin
    },
  },
} satisfies NextAuthConfig;
