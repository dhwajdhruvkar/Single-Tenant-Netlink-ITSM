import { z } from "zod";
import { parseRange } from "@/modules/reporting/range";
import { reportSummary } from "@/modules/reporting/queries";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ValidationError } from "@/platform/errors";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Query = z.object({ from: z.string().optional(), to: z.string().optional(), groupId: z.string().uuid().optional() });

// GET /api/reports/summary?from=&to=&groupId=  (agent: their team's tickets only; manager/admin: everything)
export const GET = withApi(async (req) => {
  const actor = await requireActor("reports.team");
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) throw new ValidationError(q.error.issues[0]?.message ?? "Invalid query");
  const { from, to } = parseRange(q.data);
  return ok(await reportSummary(prisma, actor, { from, to, groupId: q.data.groupId }, { policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } }));
});
