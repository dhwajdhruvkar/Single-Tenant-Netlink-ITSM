import { Assignment, assignTicket } from "@/modules/tickets/assign";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dispatchJobsAfterResponse } from "@/platform/jobsDispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { version, groupId?, assigneeEmployeeId?: <id> | "me" | null }
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const input = Assignment.parse(await readJson(req));
  const result = await assignTicket({ db: prisma, policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } }, actor, String(ctx.params.ref ?? "").toUpperCase(), input, { requestId: ctx.requestId });
  dispatchJobsAfterResponse();
  return ok(result);
});
