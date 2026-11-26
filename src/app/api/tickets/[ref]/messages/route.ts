import { NextResponse } from "next/server";
import { addMessage, MessageInput } from "@/modules/tickets/messages";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dispatchJobsAfterResponse } from "@/platform/jobsDispatch";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { body, visibility: "public" | "internal", attachmentIds[] }  (internal needs agent+)
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  await enforceRateLimit(dbRateLimiter(prisma), { key: `ticket.message:${actor.employeeId}`, limit: 30, windowSeconds: 60 });
  const input = MessageInput.parse(await readJson(req));
  const result = await addMessage({ db: prisma, policy: { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS } }, actor, String(ctx.params.ref ?? "").toUpperCase(), input);
  dispatchJobsAfterResponse();
  return NextResponse.json({ data: result }, { status: 201 });
});
