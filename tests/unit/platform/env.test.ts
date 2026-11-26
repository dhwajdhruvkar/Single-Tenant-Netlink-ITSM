import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "@/platform/config/env";

const base = { DATABASE_URL: "postgresql://itsm:itsm@localhost:5432/itsm_dev" };

describe("parseConfig", () => {
  it("applies defaults for local", () => {
    const cfg = parseConfig(base);
    expect(cfg.APP_ENV).toBe("local");
    expect(cfg.APP_BASE_URL).toBe("http://localhost:3000");
    expect(cfg.SESSION_MAX_AGE_HOURS).toBe(8);
    expect(cfg.ENTRA_ROLE_AGENT).toBe("ITSM.Agent");
    expect(cfg.DIRECTORY_SYNC_ENABLED).toBe(false);
    expect(cfg.STORAGE_PROVIDER).toBe("database");
  });

  it("fails with a readable message when DATABASE_URL is missing", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres URL and bad GUIDs, listing every problem", () => {
    try {
      parseConfig({ DATABASE_URL: "mysql://x", ENTRA_TENANT_ID: "nope" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/ENTRA_TENANT_ID/);
    }
  });

  it("does not echo secret values in errors", () => {
    expect(() => parseConfig({ DATABASE_URL: "mysql://user:hunter2@host/db" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
    );
  });

  it("requires auth/cron secrets and https in production", () => {
    expect(() => parseConfig({ ...base, APP_ENV: "production" })).toThrow(/AUTH_SECRET.*required/s);
    expect(() =>
      parseConfig({
        ...base,
        APP_ENV: "production",
        APP_BASE_URL: "http://itsm.example.com",
        AUTH_SECRET: "s".repeat(32),
        CRON_SECRET: "c".repeat(32),
        ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
        ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
        ENTRA_CLIENT_SECRET: "x",
      }),
    ).toThrow(/https/);
  });

  it("accepts a complete production config on any Postgres host (no vendor lock-in)", () => {
    const cfg = parseConfig({
      DATABASE_URL: "postgresql://itsm_app:pw@db.internal.example:5432/itsm",
      APP_ENV: "production",
      APP_BASE_URL: "https://itsm.example.com",
      AUTH_SECRET: "s".repeat(32),
      CRON_SECRET: "c".repeat(32),
      ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
      ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
      ENTRA_CLIENT_SECRET: "x",
    });
    expect(cfg.APP_ENV).toBe("production");
  });

  it("rejects short secrets and the local storage provider in production", () => {
    expect(() =>
      parseConfig({
        ...base,
        APP_ENV: "production",
        APP_BASE_URL: "https://x.example.com",
        AUTH_SECRET: "short",
        CRON_SECRET: "c".repeat(32),
        ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
        ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
        ENTRA_CLIENT_SECRET: "x",
        STORAGE_PROVIDER: "local",
      }),
    ).toThrow(/AUTH_SECRET.*32[\s\S]*STORAGE_PROVIDER/);
  });
});
