import { markRead, MarkRead } from "@/modules/notifications/inbox";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { ids: [...] } or { all: true }
export const POST = withApi(async (req) => {
  const actor = await requireActor();
  return ok(await markRead(prisma, actor, MarkRead.parse(await readJson(req))));
});
