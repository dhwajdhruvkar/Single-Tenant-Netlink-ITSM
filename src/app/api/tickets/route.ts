import { z } from "zod";
import { listTickets, SORTABLE, VIEWS, type ListQuery } from "@/modules/tickets/list";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ValidationError } from "@/platform/errors";
import { withApi } from "@/platform/http/handler";
import { parsePagination, type Pagination } from "@/platform/http/pagination";
import { requireActor } from "@/platform/http/requireActor";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const csv = <const V extends readonly [string, ...string[]]>(values: V) => z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.enum(values)).max(10));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/).transform((s) => new Date(s)).pipe(z.date());

const Filters = z.object({
  view: z.enum(VIEWS).optional(),
  status: csv(["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"]).optional(),
  priority: csv(["p1", "p2", "p3", "p4"]).optional(),
  type: z.enum(["incident", "service_request"]).optional(),
  groupId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  requesterEmployeeId: z.string().uuid().optional(),
  createdFrom: date.optional(),
  createdTo: date.optional(),
  q: z.string().trim().max(100).optional(),
});

// GET /api/tickets?view=&status=&priority=&groupId=&assigneeId=&categoryId=&createdFrom=&createdTo=&q=&page=&pageSize=&sortBy=&sortDir=
// Access is part of the database query. Employees only ever get "mine"; the queue views need agent+.
export const GET = withApi(async (req) => {
  const actor = await requireActor();
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);
  const parsed = Filters.safeParse(params);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid query", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

  // `limit` is the legacy name for pageSize (the "recent tickets" panel).
  if (params.limit && !params.pageSize) url.searchParams.set("pageSize", params.limit);
  const page: Pagination<(typeof SORTABLE)[number]> = parsePagination(url, { defaultSortBy: "createdAt", allowedSortBy: SORTABLE, defaultPageSize: 25, maxPageSize: 100 });

  const f = parsed.data;
  const view = f.view ?? (f.requesterEmployeeId ? "visible" : "mine");
  const query: ListQuery = { ...f, view, page: page.page, pageSize: page.pageSize, sortBy: page.sortBy, sortDir: page.sortDir };
  const result = await listTickets(prisma, actor, query, { policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } });
  return NextResponse.json(result);
});
