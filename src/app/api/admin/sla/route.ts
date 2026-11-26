import { listSla } from "@/modules/admin/sla";
import { prisma } from "@/platform/db/prisma";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => ok(await listSla(prisma, await requireActor())));
