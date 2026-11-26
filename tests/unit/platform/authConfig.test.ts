import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/auth.config";

describe("isPublicPath", () => {
  it("allows sign-in, access-denied, auth endpoints and health", () => {
    for (const p of ["/signin", "/access-denied", "/api/auth/callback/microsoft-entra-id", "/api/health", "/api/ready", "/_next/static/x.js"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("protects everything else, including look-alike prefixes", () => {
    for (const p of ["/", "/api/me", "/api/tickets", "/signin-evil", "/api/authx", "/api/health-secret", "/desk"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});
