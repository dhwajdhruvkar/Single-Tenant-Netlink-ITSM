import { CategoryUpdate, updateCategory } from "@/modules/admin/categories";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PATCH = withApi(async (req, ctx) => {
  const actor = await requireActor();
  return ok(await updateCategory({ db: prisma }, actor, String(ctx.params.id), CategoryUpdate.parse(await readJson(req)), ctx.requestId));
});
