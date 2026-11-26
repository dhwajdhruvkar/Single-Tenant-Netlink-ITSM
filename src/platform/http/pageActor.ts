import { auth } from "@/auth";
import type { Actor } from "@/modules/identity/actor";
import { loadActor } from "@/modules/identity/loadActor";
import { prisma } from "@/platform/db/prisma";
import { UnauthenticatedError } from "@/platform/errors";

/** The actor for a server-rendered page, or null when signed out / account no longer valid. Pages decide whether to redirect or show 403. */
export async function getPageActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.claims) return null;
  try {
    return await loadActor(prisma, session.claims);
  } catch (err) {
    if (err instanceof UnauthenticatedError) return null;
    throw err;
  }
}
