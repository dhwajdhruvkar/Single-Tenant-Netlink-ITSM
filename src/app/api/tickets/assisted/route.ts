import { NextResponse } from "next/server";
import { AssistedCreate } from "@/modules/tickets/contracts";
import { createTicket } from "@/modules/tickets/createTicket";
import { prisma } from "@/platform/db/prisma";
import { readJson, withApi } from "@/platform/http/handler";
import { readIdempotencyKey } from "@/platform/http/idempotency";
import { requireActor } from "@/platform/http/requireActor";
import { dispatchJobsAfterResponse } from "@/platform/jobsDispatch";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Form A: an agent (or submitter) files on behalf of a directory employee. Only the requester's id is accepted; their name,
// email, department etc. are re-read from the database and snapshotted by the service.
export const POST = withApi(async (req, { requestId }) => {
  const actor = await requireActor("ticket.create.assisted");
  await enforceRateLimit(dbRateLimiter(prisma), { key: `ticket.create.assisted:${actor.employeeId}`, limit: 30, windowSeconds: 60 });
  const { requesterEmployeeId, ...input } = AssistedCreate.parse(await readJson(req));
  const { ticket, replayed } = await createTicket({ db: prisma }, actor, {
    ...input,
    requester: { kind: "employee", employeeId: requesterEmployeeId },
    idempotencyKey: readIdempotencyKey(req),
    requestId,
  });
  dispatchJobsAfterResponse();
  return NextResponse.json({ data: { id: ticket.id, reference: ticket.reference } }, { status: replayed ? 200 : 201, headers: replayed ? { "Idempotency-Replayed": "true" } : {} });
});
