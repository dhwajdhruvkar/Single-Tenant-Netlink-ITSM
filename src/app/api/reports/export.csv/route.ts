import { z } from "zod";
import { writeAudit } from "@/modules/audit/auditWriter";
import { countExport, exportTicketsCsv } from "@/modules/reporting/export";
import { parseRange } from "@/modules/reporting/range";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ValidationError } from "@/platform/errors";
import { withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const Query = z.object({
  from: z.string().optional(), to: z.string().optional(), groupId: z.string().uuid().optional(),
  status: z.enum(["new", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"]).optional(),
});

// GET /api/reports/export.csv?from=&to=&groupId=&status=  (manager+). Refused above 50,000 rows; audited as report.export; formulas escaped.
export const GET = withApi(async (req, ctx) => {
  const actor = await requireActor("reports.all");
  await enforceRateLimit(dbRateLimiter(prisma), { key: `report.export:${actor.employeeId}`, limit: 5, windowSeconds: 60 });
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) throw new ValidationError(q.error.issues[0]?.message ?? "Invalid query");
  const { from, to } = parseRange(q.data);
  const filters = { from, to, groupId: q.data.groupId, status: q.data.status };
  const policy = { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS };

  const rows = await countExport(prisma, actor, filters, policy);
  await writeAudit(prisma, {
    action: "report.export", actorType: "user", actorEmployeeId: actor.employeeId, entityType: "report", requestId: ctx.requestId,
    changes: { rows, from: from.toISOString(), to: to.toISOString(), groupId: q.data.groupId ?? null, status: q.data.status ?? null },
  });

  const gen = exportTicketsCsv(prisma, actor, filters, policy);
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(enc.encode(value));
    },
    async cancel() { await gen.return(undefined); },
  });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tickets-${stamp}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
