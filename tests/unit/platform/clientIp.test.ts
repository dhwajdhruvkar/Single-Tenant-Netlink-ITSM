import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/platform/clientIp";

const reqWith = (h: Record<string, string>) => ({ headers: new Headers(h) });

afterEach(() => vi.unstubAllEnvs());

describe("clientIp", () => {
  it("ignores forwarded headers unless a trusted proxy is declared", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    vi.stubEnv("VERCEL", "");
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.9" }))).toBe("local");
  });
  it("uses x-forwarded-for first hop when trusted", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(clientIp(reqWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });
  it("rejects garbage and falls back", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(clientIp(reqWith({ "x-forwarded-for": "not-an-ip" }))).toBe("local");
    expect(clientIp(reqWith({ "x-forwarded-for": "999.1.1.1" }))).toBe("local");
  });
  it("accepts IPv6", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    expect(clientIp(reqWith({ "x-real-ip": "2001:DB8::1" }))).toBe("2001:db8::1");
  });
});
