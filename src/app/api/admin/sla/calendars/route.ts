import { NextResponse } from "next/server";
import { CalendarCreate, createCalendar } from "@/modules/admin/sla";
import { prisma } from "@/platform/db/prisma";
import { readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const r = await createCalendar({ db: prisma }, actor, CalendarCreate.parse(await readJson(req)), ctx.requestId);
  return NextResponse.json({ data: r }, { status: 201 });
});
