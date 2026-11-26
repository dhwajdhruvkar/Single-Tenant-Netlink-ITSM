import { changeStatus, StatusChange } from "@/modules/tickets/changeStatus";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dispatchJobsAfterResponse } from "@/platform/jobsDispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { version, to, holdReason?, resolutionCode?, resolutionNotes?, reason? }
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const input = StatusChange.parse(await readJson(req));
  const result = await changeStatus({ db: prisma, policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } }, actor, String(ctx.params.ref ?? "").toUpperCase(), input, { requestId: ctx.requestId });
  dispatchJobsAfterResponse();
  return ok(result);
});
