import { NextResponse } from "next/server";
import { SelfServiceCreate } from "@/modules/tickets/contracts";
import { createTicket } from "@/modules/tickets/createTicket";
import { prisma } from "@/platform/db/prisma";
import { readJson, withApi } from "@/platform/http/handler";
import { readIdempotencyKey } from "@/platform/http/idempotency";
import { requireActor } from "@/platform/http/requireActor";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Form B: an employee files a ticket for themselves. The requester is ALWAYS the signed-in actor; the strict contract
// rejects any requester/creator/snapshot/role field in the body.
export const POST = withApi(async (req, { requestId }) => {
  const actor = await requireActor("ticket.create.self");
  await enforceRateLimit(dbRateLimiter(prisma), { key: `ticket.create.self:${actor.employeeId}`, limit: 10, windowSeconds: 60 });
  const input = SelfServiceCreate.parse(await readJson(req));
  const { ticket, replayed } = await createTicket({ db: prisma }, actor, {
    ...input,
    requester: { kind: "self" },
    channel: "portal",
    idempotencyKey: readIdempotencyKey(req),
    requestId,
  });
  return NextResponse.json({ data: { id: ticket.id, reference: ticket.reference } }, { status: replayed ? 200 : 201, headers: replayed ? { "Idempotency-Replayed": "true" } : {} });
});
