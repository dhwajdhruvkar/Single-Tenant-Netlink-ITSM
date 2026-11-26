import { z } from "zod";
import { NextResponse } from "next/server";
import { addMember, MemberAdd, removeMember } from "@/modules/admin/groups";
import { ValidationError } from "@/platform/errors";
import { prisma } from "@/platform/db/prisma";
import { ok, readJson, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const r = await addMember({ db: prisma }, actor, String(ctx.params.id), MemberAdd.parse(await readJson(req)), ctx.requestId);
  return NextResponse.json({ data: r }, { status: 201 });
});
// DELETE /api/admin/groups/{id}/members?employeeId=...
export const DELETE = withApi(async (req, ctx) => {
  const actor = await requireActor();
  const employeeId = z.string().uuid().safeParse(new URL(req.url).searchParams.get("employeeId"));
  if (!employeeId.success) throw new ValidationError("employeeId is required.");
  return ok(await removeMember({ db: prisma }, actor, String(ctx.params.id), employeeId.data, ctx.requestId));
});
