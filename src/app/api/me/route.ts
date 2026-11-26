import { prisma } from "@/platform/db/prisma";
import { NotFoundError } from "@/platform/errors";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => {
  const actor = await requireActor();
  const employee = await prisma.employee.findUnique({
    where: { id: actor.employeeId },
    select: { id: true, displayName: true, mail: true, userPrincipalName: true, jobTitle: true },
  });
  if (!employee) throw new NotFoundError();
  return ok({ ...employee, role: actor.role });
});
