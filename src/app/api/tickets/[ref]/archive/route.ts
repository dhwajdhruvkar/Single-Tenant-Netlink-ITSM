import { archiveTicket, ArchiveInput } from "@/modules/tickets/archive";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { version, reason? }  (manager+)
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const input = ArchiveInput.parse(await readJson(req));
  return ok(await archiveTicket({ db: prisma, policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } }, actor, String(ctx.params.ref ?? "").toUpperCase(), input, { requestId: ctx.requestId }));
});
