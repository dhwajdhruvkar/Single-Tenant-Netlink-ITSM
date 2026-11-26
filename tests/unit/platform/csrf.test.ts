import { describe, expect, it } from "vitest";
import { assertSameOrigin } from "@/platform/http/csrf";

const BASE = "https://itsm.example.com";
const post = (headers: Record<string, string> = {}, method = "POST") => new Request(`${BASE}/api/x`, { method, headers });

describe("assertSameOrigin", () => {
  it("ignores safe methods", () => {
    expect(() => assertSameOrigin(post({ "sec-fetch-site": "cross-site" }, "GET"), BASE)).not.toThrow();
  });
  it("allows same-origin browser requests", () => {
    expect(() => assertSameOrigin(post({ "sec-fetch-site": "same-origin", origin: BASE }), BASE)).not.toThrow();
  });
  it("rejects cross-site and same-site-other-origin requests", () => {
    expect(() => assertSameOrigin(post({ "sec-fetch-site": "cross-site" }), BASE)).toThrow(/Cross-site/);
    expect(() => assertSameOrigin(post({ "sec-fetch-site": "same-site" }), BASE)).toThrow(/Cross-site/);
  });
  it("rejects a mismatching Origin header even without Sec-Fetch-Site", () => {
    expect(() => assertSameOrigin(post({ origin: "https://evil.example" }), BASE)).toThrow(/Cross-site/);
  });
  it("allows non-browser clients that send neither header", () => {
    expect(() => assertSameOrigin(post(), BASE)).not.toThrow();
  });
  for (const m of ["PUT", "PATCH", "DELETE"]) {
    it(`checks ${m}`, () => {
      expect(() => assertSameOrigin(post({ origin: "https://evil.example" }, m), BASE)).toThrow();
    });
  }
});
