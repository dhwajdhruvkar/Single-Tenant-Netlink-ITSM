import { readAttachment, softDeleteAttachment } from "@/modules/attachments/service";
import { StorageUnavailableError } from "@/modules/attachments/ports";
import { AppError } from "@/platform/errors";
import { contentDisposition } from "@/platform/http/contentDisposition";
import { ok, withApi } from "@/platform/http/handler";
import { requireActor } from "@/platform/http/requireActor";
import { getAttachmentDeps } from "@/platform/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async (_req, ctx) => {
  const actor = await requireActor();
  try {
    const f = await readAttachment(getAttachmentDeps(), actor, String(ctx.params.id ?? ""), { requestId: ctx.requestId });
    return new Response(new Uint8Array(f.body), {
      status: 200,
      headers: {
        "Content-Type": f.contentType,
        "Content-Length": String(f.body.length),
        "Content-Disposition": contentDisposition(f.fileName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw new AppError(503, "storage_unavailable", err.message);
    throw err;
  }
});

// Remove a not-yet-attached upload (uploader) or, for agents, an attachment on a ticket they can see. Soft delete; bytes are purged later.
export const DELETE = withApi(async (_req, ctx) => {
  const actor = await requireActor();
  await softDeleteAttachment(getAttachmentDeps(), actor, String(ctx.params.id ?? ""));
  return ok({ deleted: true });
});
