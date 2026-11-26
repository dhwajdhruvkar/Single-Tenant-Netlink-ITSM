import { NextResponse } from "next/server";
import { createGroup, GroupCreate, listGroups } from "@/modules/admin/groups";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => ok(await listGroups(prisma, await requireActor())));
export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const r = await createGroup({ db: prisma }, actor, GroupCreate.parse(await readJson(req)), ctx.requestId);
  return NextResponse.json({ data: r }, { status: 201 });
});
