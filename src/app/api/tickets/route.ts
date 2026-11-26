import { z } from "zod";
import { listRecentForRequester } from "@/modules/tickets/queries";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Query = z.object({ requesterEmployeeId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(20).default(5) });

// Phase 5C subset: recent tickets for one requester, restricted to what the caller may see (agent+). The full list arrives in Phase 7.
export const GET = withApi(async (req) => {
  const actor = await requireActor("ticket.view.queue");
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  const rows = await listRecentForRequester(prisma, actor, q.requesterEmployeeId, q.limit, { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS });
  return ok(rows.map((r) => ({ id: r.id, reference: r.reference, subject: r.subject, status: r.status, priority: r.priority, createdAt: r.createdAt.toISOString() })));
});
