import { z } from "zod";
import { NextResponse } from "next/server";
import { addHoliday, HolidayAdd, removeHoliday } from "@/modules/admin/sla";
import { ValidationError } from "@/platform/errors";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const r = await addHoliday({ db: prisma }, actor, String(ctx.params.id), HolidayAdd.parse(await readJson(req)), ctx.requestId);
  return NextResponse.json({ data: r }, { status: 201 });
});
// DELETE /api/admin/sla/calendars/{id}/holidays?holidayId=...
export const DELETE = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const holidayId = z.string().uuid().safeParse(new URL(req.url).searchParams.get("holidayId"));
  if (!holidayId.success) throw new ValidationError("holidayId is required.");
  return ok(await removeHoliday({ db: prisma }, actor, String(ctx.params.id), holidayId.data, ctx.requestId));
});
