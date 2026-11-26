import { NextResponse } from "next/server";
import { z } from "zod";
import { listNotifications } from "@/modules/notifications/inbox";
import { prisma } from "@/platform/db/prisma";
import { ValidationError } from "@/platform/errors";
import { withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), unread: z.enum(["1", "true"]).optional() });

// GET /api/notifications?limit=&unread=1 -> { data: [...], meta: { unread } } (the caller's own notifications only)
export const GET = withApi(async (req) => {
  const actor = await requireActor();
  const q = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) throw new ValidationError(q.error.issues[0]?.message ?? "Invalid query");
  const r = await listNotifications(prisma, actor, { limit: q.data.limit, unreadOnly: q.data.unread !== undefined });
  return NextResponse.json({ data: r.data, meta: { unread: r.unread } });
});
