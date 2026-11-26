import { describe, expect, it } from "vitest";
import { effectiveMaxBytes, looksExecutable, sanitizeFileName, validateUpload } from "@/modules/attachments/validation";
import { assertValidKey, isValidKey, keyEnvFor, makeStorageKey } from "@/modules/attachments/keys";
import { ELF, EXE, OLE, PDF, PNG, SCRIPT, SVG, TEXT, ZIP, JPEG } from "../../support/files";

const MAX = 4 * 1024 * 1024;
const ok = (fileName: string, declaredType: string, bytes: Buffer) => validateUpload({ fileName, declaredType, bytes }, MAX);
const rejects = (fileName: string, declaredType: string, bytes: Buffer, message?: RegExp) => {
  expect(() => ok(fileName, declaredType, bytes)).toThrow(message);
};

describe("sanitizeFileName", () => {
  it("strips directories (path traversal)", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\jane\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("a/b/../c.txt")).toBe("c.txt");
  });
  it("removes control characters and bidirectional overrides (RTL spoofing)", () => {
    expect(sanitizeFileName("inv\u202Eoice.pdf")).toBe("invoice.pdf");
    expect(sanitizeFileName("a\u0000b\u0007c.txt")).toBe("abc.txt");
    expect(sanitizeFileName("x\u200Fy\u2066z.txt")).toBe("xyz.txt");
  });
  it("replaces risky characters, keeps letters from any script", () => {
    expect(sanitizeFileName('we<ird>:"name*?.txt')).toBe("we_ird_name_.txt");
    expect(sanitizeFileName("отчёт 2026.pdf")).toBe("отчёт 2026.pdf");
    expect(sanitizeFileName("报告.docx")).toBe("报告.docx");
  });
  it("drops leading dots and trailing dots/spaces, and never returns empty", () => {
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    expect(sanitizeFileName("report.pdf. . ")).toBe("report.pdf");
    for (const n of ["", "   ", "...", "/", "\u202E"]) expect(sanitizeFileName(n)).toBe("file");
  });
  it("caps the length but keeps the extension", () => {
    const out = sanitizeFileName(`${"a".repeat(300)}.pdf`);
    expect(out.length).toBe(140);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("validateUpload: accepted files", () => {
  it("accepts typical documents and returns size, hash and sanitised name", () => {
    const r = ok("Quarterly Report.pdf", "application/pdf", PDF);
    expect(r).toMatchObject({ fileName: "Quarterly Report.pdf", contentType: "application/pdf", sizeBytes: PDF.length });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("accepts png, jpeg, docx/xlsx (zip container), legacy office, text, svg", () => {
    ok("shot.png", "image/png", PNG);
    ok("shot.jpg", "image/jpeg", JPEG);
    ok("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ZIP);
    ok("a.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ZIP);
    ok("old.doc", "application/msword", OLE);
    ok("mail.msg", "application/vnd.ms-outlook", OLE);
    ok("log.txt", "text/plain", TEXT);
    ok("diagram.svg", "image/svg+xml", SVG);
  });
  it("ignores type parameters and case", () => {
    expect(ok("n.txt", "Text/Plain; charset=utf-8", TEXT).contentType).toBe("text/plain");
  });
  it("accepts application/octet-stream only for known-safe extensions", () => {
    ok("data.csv", "application/octet-stream", TEXT);
    ok("scan.pdf", "application/octet-stream", PDF);
    rejects("thing.xyz", "application/octet-stream", TEXT, /not allowed/);
    rejects("noextension", "application/octet-stream", TEXT, /not allowed/);
  });
});

describe("validateUpload: rejections", () => {
  it("an EXE is rejected by extension, by declared type and by content", () => {
    rejects("setup.exe", "application/octet-stream", EXE, /\.exe files are not allowed/);
    rejects("setup.exe", "application/pdf", PDF, /\.exe/);
    rejects("harmless.txt", "text/plain", EXE, /Executable/); // MZ header under an innocent name
    rejects("harmless.pdf", "application/pdf", EXE, /Executable/);
    rejects("tool.bin", "application/octet-stream", ELF, /not allowed|Executable/);
  });
  it("blocked script and installer extensions", () => {
    for (const ext of ["dll", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jar", "msi", "sh", "apk", "hta", "lnk"]) {
      rejects(`file.${ext}`, "text/plain", TEXT, new RegExp(`\\.${ext} files`));
    }
  });
  it("a script is rejected by its shebang whatever it is called", () => {
    rejects("notes.txt", "text/plain", SCRIPT, /Executable/);
    expect(looksExecutable(SCRIPT)).toBe(true);
    expect(looksExecutable(TEXT)).toBe(false);
  });
  it("a double extension hiding an executable name is rejected", () => {
    rejects("invoice.exe.pdf", "application/pdf", PDF, /\.exe/);
    rejects("invoice.pdf.exe", "application/pdf", PDF, /\.exe/);
  });
  it("RTL override spoofing cannot hide the real extension", () => {
    rejects("invoice\u202Efdp.exe", "application/pdf", PDF, /\.exe/);
  });
  it("a PNG renamed to .pdf is rejected, whichever type the browser declared", () => {
    rejects("holiday.pdf", "application/pdf", PNG, /does not match/);
    rejects("holiday.pdf", "image/png", PNG, /extension does not match/);
    rejects("holiday.pdf", "application/octet-stream", PNG, /does not match/);
  });
  it("a PDF renamed to .png, and text pretending to be an image, are rejected", () => {
    rejects("scan.png", "image/png", PDF, /does not match/);
    rejects("fake.png", "image/png", TEXT, /does not match/);
    rejects("fake.pdf", "application/pdf", TEXT, /does not match/);
    rejects("fake.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", TEXT, /does not match/);
  });
  it("an SVG without svg content is rejected", () => {
    rejects("x.svg", "image/svg+xml", TEXT, /does not match/);
  });
  it("disallowed types are rejected", () => {
    rejects("page.html", "text/html", TEXT, /not allowed/);
    rejects("clip.avi", "video/x-msvideo", TEXT, /not allowed/);
    rejects("app.js", "application/javascript", TEXT, /\.js|not allowed/);
  });
  it("empty files and over-limit files are rejected (413 for size)", () => {
    rejects("empty.txt", "text/plain", Buffer.alloc(0), /empty/);
    expect(() => validateUpload({ fileName: "big.txt", declaredType: "text/plain", bytes: Buffer.alloc(MAX + 1, 97) }, MAX)).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => validateUpload({ fileName: "ok.txt", declaredType: "text/plain", bytes: Buffer.alloc(MAX, 97) }, MAX)).not.toThrow();
  });
});

describe("effectiveMaxBytes", () => {
  it("caps at 4 MB for database storage and on Vercel", () => {
    expect(effectiveMaxBytes({ ATTACHMENT_MAX_BYTES: 26_214_400, STORAGE_PROVIDER: "database" }, {})).toBe(4 * 1024 * 1024);
    expect(effectiveMaxBytes({ ATTACHMENT_MAX_BYTES: 26_214_400, STORAGE_PROVIDER: "s3" }, { VERCEL: "1" })).toBe(4 * 1024 * 1024);
  });
  it("honours the configured limit elsewhere, and a smaller configured limit anywhere", () => {
    expect(effectiveMaxBytes({ ATTACHMENT_MAX_BYTES: 26_214_400, STORAGE_PROVIDER: "s3" }, {})).toBe(26_214_400);
    expect(effectiveMaxBytes({ ATTACHMENT_MAX_BYTES: 1000, STORAGE_PROVIDER: "database" }, {})).toBe(1000);
  });
});

describe("storage keys", () => {
  it("are namespaced by environment and date", () => {
    const k = makeStorageKey("staging", new Date("2026-03-09T10:00:00Z"), "11111111-2222-4333-8444-555555555555");
    expect(k).toBe("itsm/staging/att/2026/03/11111111-2222-4333-8444-555555555555");
    expect(k.startsWith("itsm/")).toBe(true);
  });
  it("map APP_ENV to a namespace (test shares local)", () => {
    expect([keyEnvFor("production"), keyEnvFor("staging"), keyEnvFor("local"), keyEnvFor("test")]).toEqual(["production", "staging", "local", "local"]);
  });
  it("reject anything that is not exactly the documented shape", () => {
    for (const bad of ["../../etc/passwd", "itsm/prod/att/2026/03/x", "itsm/local/att/2026/03/../../x", "/itsm/local/att/2026/03/11111111-2222-4333-8444-555555555555", "itsm/local/att/2026/3/11111111-2222-4333-8444-555555555555", "itsm/local/att/2026/03/11111111-2222-4333-8444-555555555555/extra", "itsm/other/att/2026/03/11111111-2222-4333-8444-555555555555", ""]) {
      expect(isValidKey(bad), bad).toBe(false);
      expect(() => assertValidKey(bad)).toThrow();
    }
  });
});
