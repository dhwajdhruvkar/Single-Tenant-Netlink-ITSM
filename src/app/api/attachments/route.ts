import { NextResponse } from "next/server";
import { stageAttachment } from "@/modules/attachments/service";
import { StorageUnavailableError } from "@/modules/attachments/ports";
import { AppError, ValidationError } from "@/platform/errors";
import { prisma } from "@/platform/db/prisma";
import { withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { dbRateLimiter, enforceRateLimit } from "@/platform/rateLimit/dbRateLimit";
import { getAttachmentDeps } from "@/platform/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MULTIPART_OVERHEAD = 64 * 1024;

// POST multipart/form-data with one `file` field. Stages the upload; the id is later sent in `attachmentIds` when the ticket is created.
export const POST = withApi(async (req, { requestId }) => {
  const actor = await requireActor("ticket.create.self");
  const deps = getAttachmentDeps();
  await enforceRateLimit(dbRateLimiter(prisma), { key: `attachments.upload:${actor.employeeId}`, limit: 30, windowSeconds: 60 });

  // Refuse oversized bodies before reading them into memory.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > deps.maxBytes + MULTIPART_OVERHEAD) throw new AppError(413, "payload_too_large", "The file is too large.");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new ValidationError("Send the file as multipart/form-data.");

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError('Send exactly one file in the "file" field.');

  try {
    const staged = await stageAttachment(deps, actor, { fileName: file.name, declaredType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json({ data: staged }, { status: 201 });
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw new AppError(503, "storage_unavailable", err.message);
    throw err;
  } finally {
    void requestId;
  }
});
