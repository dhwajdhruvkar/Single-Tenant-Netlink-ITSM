import { auth } from "@/auth";
import type { Actor } from "@/modules/identity/actor";
import { loadActor } from "@/modules/identity/loadActor";
import { can, type Permission } from "@/modules/identity/permissions";
import { loadConfig } from "@/platform/config/env";
import { prisma } from "@/platform/db/prisma";
import { ForbiddenError, UnauthenticatedError } from "@/platform/errors";

/**
 * The single entry point for authenticating an API request: session -> database actor (active, session version, role) ->
 * optional permission check. Throws 401/403. Nothing about identity or role is ever read from the request body or headers.
 */
export async function requireActor(permission?: Permission): Promise<Actor> {
  const session = await auth();
  if (!session?.claims) throw new UnauthenticatedError();
  const actor = await loadActor(prisma, session.claims);
  if (permission && !can(actor.role, permission, { agentsViewAllTickets: loadConfig().AGENTS_VIEW_ALL_TICKETS })) {
    throw new ForbiddenError();
  }
  return actor;
}
