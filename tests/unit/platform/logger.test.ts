import { describe, expect, it } from "vitest";
import { redactLogMeta } from "@/platform/logging/logger";

describe("redactLogMeta", () => {
  it("redacts sensitive keys, bearer tokens and URL credentials", () => {
    const out = redactLogMeta({
      clientSecret: "abc",
      DATABASE_URL: "postgresql://u:p@h/db",
      note: "Authorization: Bearer abc.def.ghi and postgresql://user:pw@host/db",
      nested: { password: "x", ok: 1 },
    })!;
    expect(out.clientSecret).toBe("[REDACTED]");
    expect(out.DATABASE_URL).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toMatch(/abc\.def|user:pw|:pw@/);
    expect((out.nested as { password: string; ok: number })).toEqual({ password: "[REDACTED]", ok: 1 });
  });
  it("handles circular references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => redactLogMeta(a)).not.toThrow();
  });
});
