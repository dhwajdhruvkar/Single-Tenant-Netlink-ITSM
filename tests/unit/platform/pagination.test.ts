import { describe, expect, it } from "vitest";
import { pageMeta, parsePagination } from "@/platform/http/pagination";

const opts = { defaultSortBy: "createdAt", allowedSortBy: ["createdAt", "priority"] as const };
const parse = (qs: string) => parsePagination(`http://x/api?${qs}`, opts);

describe("parsePagination", () => {
  it("uses defaults", () => {
    expect(parse("")).toEqual({ page: 1, pageSize: 25, skip: 0, take: 25, sortBy: "createdAt", sortDir: "desc" });
  });
  it("computes skip", () => {
    expect(parse("page=3&pageSize=10").skip).toBe(20);
  });
  it.each(["page=0", "page=-1", "page=1.5", "page=abc", "pageSize=0", "pageSize=101", `page=${"9".repeat(20)}`])(
    "rejects %s",
    (qs) => expect(() => parse(qs)).toThrow(/page|pageSize/),
  );
  it("rejects unknown sort fields and directions", () => {
    expect(() => parse("sortBy=password")).toThrow(/sortBy/);
    expect(() => parse("sortDir=sideways")).toThrow(/sortDir/);
  });
  it("computes meta", () => {
    expect(pageMeta(51, { page: 1, pageSize: 25 })).toEqual({ total: 51, page: 1, pageSize: 25, totalPages: 3 });
  });
});
