import { getTicketDetail } from "@/modules/tickets/detail";
import { TicketPatch, updateTicket } from "@/modules/tickets/updateTicket";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { NotFoundError } from "@/platform/errors";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const policy = () => ({ agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS });
const refOf = (p: Record<string, string | string[]>) => String(p.ref ?? "").toUpperCase();

export const GET = withApi(async (_req, ctx) => {
  const actor = await requireActor();
  const t = await getTicketDetail(prisma, actor, refOf(ctx.params), { policy: policy() });
  if (!t) throw new NotFoundError();
  return ok(t);
});

// PATCH { version, priority?, impact?, urgency?, categoryId?, type?, reason? }
export const PATCH = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const input = TicketPatch.parse(await readJson(req));
  return ok(await updateTicket({ db: prisma, policy: policy() }, actor, refOf(ctx.params), input, { requestId: ctx.requestId }));
});
