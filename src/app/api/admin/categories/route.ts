import { NextResponse } from "next/server";
import { CategoryCreate, createCategory, listCategories } from "@/modules/admin/categories";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => ok(await listCategories(prisma, await requireActor())));
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const r = await createCategory({ db: prisma }, actor, CategoryCreate.parse(await readJson(req)), ctx.requestId);
  return NextResponse.json({ data: r }, { status: 201 });
});
