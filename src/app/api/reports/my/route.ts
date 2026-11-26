import { mySummary } from "@/modules/reporting/queries";
import { prisma } from "@/platform/db/prisma";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The caller's own tickets at a glance (employee dashboard).
export const GET = withApi(async () => ok(await mySummary(prisma, await requireActor("dashboard.own"))));
