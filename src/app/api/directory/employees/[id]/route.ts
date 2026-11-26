import { getEmployeeById } from "@/modules/directory/searchService";
import { prisma } from "@/platform/db/prisma";
import { NotFoundError } from "@/platform/errors";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async (_req, ctx) => {
  await requireActor("directory.search");
  const id = String(ctx.params.id ?? "");
  const employee = await getEmployeeById(prisma, id);
  if (!employee) throw new NotFoundError("Employee not found.");
  return ok(employee);
});
