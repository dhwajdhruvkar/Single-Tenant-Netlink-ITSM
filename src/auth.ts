import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { authConfig } from "@/auth.config";
import { readEntraClaims } from "@/modules/identity/claims";
import { handleSignIn, recordSignInDenied } from "@/modules/identity/signInService";
import { writeAudit } from "@/modules/audit/auditWriter";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { logger } from "@/platform/logging/logger";

// Lazy initialisation: configuration is read per request, so `next build` does not need Entra settings.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const cfg = loadConfig();
  if (!cfg.ENTRA_TENANT_ID || !cfg.ENTRA_CLIENT_ID || !cfg.ENTRA_CLIENT_SECRET || !cfg.AUTH_SECRET) {
    throw new Error("Entra sign-in is not configured: set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and AUTH_SECRET.");
  }
  const tenantId = cfg.ENTRA_TENANT_ID;
  const mapping = {
    agent: cfg.ENTRA_ROLE_AGENT,
    manager: cfg.ENTRA_ROLE_MANAGER,
    admin: cfg.ENTRA_ROLE_ADMIN,
    submitter: cfg.ENTRA_ROLE_SUBMITTER,
  };

  return {
    ...authConfig,
    secret: cfg.AUTH_SECRET,
    trustHost: cfg.AUTH_TRUST_HOST,
    session: { strategy: "jwt", maxAge: cfg.SESSION_MAX_AGE_HOURS * 3600, updateAge: 3600 },
    providers: [
      MicrosoftEntraID({
        clientId: cfg.ENTRA_CLIENT_ID,
        clientSecret: cfg.ENTRA_CLIENT_SECRET,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        authorization: { params: { scope: "openid profile email User.Read" } },
        // The stock provider downloads the profile photo from Graph. We never fetch or store photos.
        profile: (profile) => ({ id: String(profile.oid ?? profile.sub), name: profile.name, email: profile.email ?? null, image: null }),
      }),
    ],
    callbacks: {
      ...authConfig.callbacks,
      async signIn({ user, profile }) {
        try {
          const parsed = readEntraClaims(profile as Record<string, unknown> | undefined, tenantId);
          if (!parsed.ok) {
            await recordSignInDenied(prisma, parsed.reason);
            return `/access-denied?reason=${parsed.reason}`;
          }
          const result = await handleSignIn(prisma, parsed.claims, mapping);
          if (!result.allowed) return `/access-denied?reason=${result.reason}`;
          user.uaid = result.userAccountId;
          user.eid = result.employeeId;
          user.sv = result.sessionVersion;
          return true;
        } catch (err) {
          logger.error("sign-in failed", { error: err });
          return "/access-denied?reason=sign_in_failed";
        }
      },
    },
    events: {
      async signOut(message) {
        const token = "token" in message ? message.token : null;
        try {
          await writeAudit(prisma, {
            action: "auth.signout",
            actorType: "user",
            actorEmployeeId: token?.eid ?? null,
            entityType: "user_account",
            entityId: token?.uaid ?? null,
          });
        } catch (err) {
          logger.error("could not audit sign-out", { error: err });
        }
      },
    },
  };
});
