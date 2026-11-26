import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/platform/http/contentDisposition";

describe("contentDisposition", () => {
  it("is always an attachment, with ASCII and UTF-8 names", () => {
    expect(contentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const h = contentDisposition("отчёт.pdf");
    expect(h).toContain('filename="_____.pdf"');
    expect(h).toContain("filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf");
  });
  it("cannot be used to inject headers or break out of the quoted string", () => {
    for (const evil of ['a"; filename="evil.exe', "a\r\nSet-Cookie: x=1", "a\nb", 'x\\"y', "a;b"]) {
      const h = contentDisposition(evil);
      expect(h).not.toMatch(/[\r\n]/);
      const ascii = h.match(/filename="([^"]*)"/)![1];
      expect(ascii).not.toMatch(/["\;\r\n]/);
      expect(h.startsWith("attachment;")).toBe(true);
    }
  });
  it("percent-encodes characters that are special in RFC 5987", () => {
    expect(contentDisposition("it's (1)*.txt")).toContain("it%27s%20%281%29%2A.txt");
  });
});
