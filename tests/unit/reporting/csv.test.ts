import { describe, expect, it } from "vitest";
import { csvCell, csvRow, neutraliseFormula } from "@/modules/reporting/csv";

describe("formula injection", () => {
  const dangerous = ["=SUM(A1:A9)", "+1+1", "-2+3", "@SUM(1)", "=cmd|' /C calc'!A0", '=HYPERLINK("http://evil.example","click")', "\t=1+1", "\r=1+1", "  =1+1", "\u0000=1+1", "\n=1+1"];

  it.each(dangerous)("prefixes %j with an apostrophe", (v) => {
    expect(neutraliseFormula(v).startsWith("'")).toBe(true);
    expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("leaves ordinary text, digits and text that merely contains a formula character untouched", () => {
    for (const v of ["Printer jammed", "2026-03-04", "a=b", "x+y", "e-mail", "user@example.test", "(=)", "'quoted'", ""]) expect(neutraliseFormula(v)).toBe(v);
  });

  it("is applied to every text cell of a row, and not to numbers, booleans, dates or nulls", () => {
    const row = csvRow(["=1+1", 42, true, new Date("2026-03-04T10:00:00Z"), null, undefined, "-5 degrees"]);
    expect(row).toBe("'=1+1,42,true,2026-03-04T10:00:00.000Z,,,'-5 degrees\r\n");
  });

  it("a malicious subject cannot execute: it stays one quoted text cell", () => {
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
  });
});

describe("RFC 4180 quoting", () => {
  it("quotes cells with commas, quotes and line breaks, doubling inner quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  it("quotes cells with leading/trailing spaces so they survive a round trip", () => {
    expect(csvCell(" padded ")).toBe('" padded "');
  });
  it("a hostile cell cannot add columns or rows", () => {
    const row = csvRow(['evil","injected', "next"]);
    expect(row.split("\r\n")[0]).toBe('"evil"",""injected",next');
    expect(row.endsWith("\r\n")).toBe(true);
    expect(row.match(/\r\n/g)).toHaveLength(1);
  });
  it("keeps unicode intact", () => expect(csvCell("Привет 👋 报告")).toBe("Привет 👋 报告"));
});
