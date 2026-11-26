import { getOwnProfile } from "@/modules/directory/profileService";
import { prisma } from "@/platform/db/prisma";
import { getDirectoryProvider, getEligibilityConfig } from "@/platform/directory";
import { NotFoundError } from "@/platform/errors";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The signed-in person's own directory profile. Missing fields are null; the UI shows "Not provided in directory".
export const GET = withApi(async () => {
  const actor = await requireActor();
  const profile = await getOwnProfile({ db: prisma, provider: getDirectoryProvider(), eligibility: getEligibilityConfig() }, actor.employeeId);
  if (!profile) throw new NotFoundError();
  return ok(profile);
});
