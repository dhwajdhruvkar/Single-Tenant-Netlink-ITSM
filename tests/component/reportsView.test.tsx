// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReportSummary } from "@/modules/reporting/queries";
import { ReportsView } from "@/ui/reports/ReportsView";

const base: ReportSummary = {
  scope: "all", range: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-11T00:00:00.000Z" }, groupId: null, generatedAt: "2026-03-10T12:00:00.000Z",
  openTotal: 5, openByStatus: [{ status: "in_progress", count: 3 }, { status: "new", count: 2 }], openByPriority: [{ priority: "p1", count: 1 }], openByGroup: [{ groupId: null, name: "Unassigned", count: 5 }],
  createdVsResolved: [{ day: "2026-03-01", created: 2, resolved: 1 }, { day: "2026-03-02", created: 0, resolved: 3 }], createdTotal: 2, resolvedTotal: 4,
  resolveTime: { count: 4, avgMinutes: 4200, medianMinutes: 1020 }, firstResponse: { count: 0, avgMinutes: null, medianMinutes: null },
  sla: { resolve: { met: 2, total: 4, pct: 50 }, response: { met: 0, total: 0, pct: null }, breachedOpen: 1 },
  backlogAge: [{ bucket: "< 1 day", count: 1 }], oldestOpenDays: 8, perAgent: [{ employeeId: "e1", name: "Alice <b>x</b>", resolved: 3, medianMinutes: 1440 }],
};
const props = { groups: [{ id: "g1", name: "Desk" }], basePath: "/admin/reports", from: "2026-03-01", to: "2026-03-10" };

afterEach(cleanup);

describe("ReportsView", () => {
  it("shows the headline numbers, formatted, with 'no data' dashes instead of NaN or 0", () => {
    render(<ReportsView summary={base} canExport {...props} />);
    expect(screen.getAllByText("Median time to resolve")[0].parentElement?.textContent).toContain("17 h");
    expect(screen.getByText("Median first response").parentElement?.textContent).toContain("–");
    expect(screen.getByText("Response SLA met").parentElement?.textContent).toContain("–");
    expect(screen.getByText("Resolution SLA met").parentElement?.textContent).toContain("50%");
    expect(document.body.textContent).not.toMatch(/NaN|undefined|null/);
  });
  it("offers the CSV download only when allowed, carrying the period", () => {
    const { unmount } = render(<ReportsView summary={base} canExport {...props} />);
    expect(screen.getByRole("link", { name: "Download CSV" }).getAttribute("href")).toBe("/api/reports/export.csv?from=2026-03-01&to=2026-03-10");
    unmount();
    render(<ReportsView summary={{ ...base, scope: "team" }} canExport={false} {...props} />);
    expect(screen.queryByRole("link", { name: "Download CSV" })).toBeNull();
    expect(screen.getByRole("option", { name: "All my groups" })).toBeTruthy();
  });
  it("every chart has a text alternative and agent names are rendered as text, not markup", () => {
    render(<ReportsView summary={base} canExport {...props} />);
    expect(screen.getByRole("img", { name: /Created vs resolved per day/ })).toBeTruthy();
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + two days
    expect(screen.getByText("Alice <b>x</b>")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });
  it("says so when there is nothing to chart", () => {
    render(<ReportsView summary={{ ...base, openTotal: 0, openByStatus: [], openByPriority: [], openByGroup: [], backlogAge: [], createdVsResolved: [{ day: "2026-03-01", created: 0, resolved: 0 }], perAgent: [], oldestOpenDays: null }} canExport {...props} />);
    expect(screen.getByText("No tickets created or resolved in this period.")).toBeTruthy();
    expect(screen.getAllByText("No open tickets.")).toHaveLength(4);
    expect(screen.getByText("No tickets were resolved in this period.")).toBeTruthy();
  });
});
