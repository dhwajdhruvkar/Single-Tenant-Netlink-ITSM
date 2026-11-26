import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "@/modules/audit/auditWriter";
import type { Actor } from "@/modules/identity/actor";
import { can, type PolicyOptions } from "@/modules/identity/permissions";
import { canViewInternal, canViewTicket } from "@/modules/identity/policies";
import { systemClock, type Clock } from "@/platform/clock";
import { AppError, ConflictError, NotFoundError, UnprocessableError, ValidationError } from "@/platform/errors";
import { logger } from "@/platform/logging/logger";
import { makeStorageKey, type KeyEnv } from "./keys";
import { noopScanner, type MalwareScanner, type ObjectStorage } from "./ports";
import { MAX_FILES_PER_TICKET, validateUpload, type UploadInput } from "./validation";

export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
export const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // [OPEN]

export interface AttachmentDeps {
  db: PrismaClient;
  storage: ObjectStorage;
  keyEnv: KeyEnv;
  maxBytes: number;
  scanner?: MalwareScanner;
  clock?: Clock;
  /** [OPEN] When true a file must be scanned clean before anyone can download it. */
  requireCleanScan?: boolean;
  policy?: PolicyOptions;
}

export interface StagedAttachmentDTO {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "staged";
}

/** Validate, store and record an upload as `staged`. It belongs to nobody's ticket until it is linked by its uploader. */
export async function stageAttachment(deps: AttachmentDeps, actor: Actor, input: UploadInput): Promise<StagedAttachmentDTO> {
  if (!can(actor.role, "ticket.create.self")) throw new AppError(403, "forbidden", "You do not have permission to do this.");
  const v = validateUpload(input, deps.maxBytes);
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const key = makeStorageKey(deps.keyEnv, now);

  const scan = await (deps.scanner ?? noopScanner).scan(v.fileName, input.bytes).catch(() => "failed" as const);
  if (scan === "infected") throw new ValidationError("The file was rejected by the malware scanner.");

  await deps.storage.put(key, input.bytes, { contentType: v.contentType });
  try {
    const row = await deps.db.attachment.create({
      data: {
        status: "staged",
        storageProvider: deps.storage.provider,
        storageKey: key,
        fileName: v.fileName,
        contentType: v.contentType,
        sizeBytes: v.sizeBytes,
        sha256: v.sha256,
        scanStatus: scan,
        scannedAt: scan === "not_scanned" ? null : now,
        uploadedByEmployeeId: actor.employeeId,
        createdAt: now,
      },
    });
    return { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes, status: "staged" };
  } catch (err) {
    await deps.storage.delete(key).catch((e) => logger.error("could not remove orphaned object after failed insert", { error: e }));
    throw err;
  }
}

type TxLike = Pick<Prisma.TransactionClient, "attachment">;

/**
 * Link staged uploads to a ticket (and optionally a message) INSIDE the caller's transaction. Only `staged` rows uploaded by the
 * same actor in the last 24 h can be linked; anything else rolls the whole transaction back with a 422. The conditional update is
 * race-safe: two requests cannot both claim the same attachment.
 */
export async function linkStagedAttachments(
  tx: TxLike,
  input: { actorEmployeeId: string; ids: string[]; ticketId: string; messageId?: string | null; now: Date },
): Promise<void> {
  const { ids } = input;
  if (ids.length === 0) return;
  if (ids.length > MAX_FILES_PER_TICKET) throw new ValidationError(`At most ${MAX_FILES_PER_TICKET} attachments are allowed.`);
  if (new Set(ids).size !== ids.length) throw new ValidationError("An attachment was listed twice.");

  const cutoff = new Date(input.now.getTime() - STAGED_TTL_MS);
  const r = await tx.attachment.updateMany({
    where: { id: { in: ids }, status: "staged", uploadedByEmployeeId: input.actorEmployeeId, createdAt: { gte: cutoff } },
    data: { status: "linked", ticketId: input.ticketId, messageId: input.messageId ?? null, linkedAt: input.now },
  });
  if (r.count !== ids.length) {
    // One message for every cause (unknown, someone else's, already linked, expired): it must not reveal which.
    throw new UnprocessableError("ATTACHMENT_INVALID", "One or more attachments cannot be used. Upload them again.");
  }
}

export interface DownloadResult {
  body: Buffer;
  contentType: string;
  fileName: string;
  sizeBytes: number;
}

/**
 * Fetch an attachment for download. Returns 404 (never 403) when the actor may not see it, so existence is not revealed:
 * staged files are visible only to their uploader; linked files need `canViewTicket`; files on an internal message additionally
 * need `canViewInternal`.
 */
export async function readAttachment(deps: AttachmentDeps, actor: Actor, id: string, ctx: { requestId?: string } = {}): Promise<DownloadResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError();
  const a = await deps.db.attachment.findUnique({
    where: { id },
    include: {
      ticket: { select: { id: true, requesterEmployeeId: true, createdByEmployeeId: true, assigneeEmployeeId: true, assignmentGroupId: true, archivedAt: true } },
      message: { select: { visibility: true, deletedAt: true } },
    },
  });
  if (!a || a.status === "deleted") throw new NotFoundError();

  if (a.status === "staged") {
    if (a.uploadedByEmployeeId !== actor.employeeId) throw new NotFoundError();
  } else {
    if (!a.ticket || a.ticket.archivedAt) throw new NotFoundError();
    if (!canViewTicket(actor, a.ticket, deps.policy)) throw new NotFoundError();
    if (a.message) {
      if (a.message.deletedAt) throw new NotFoundError();
      if (a.message.visibility === "internal" && !canViewInternal(actor, a.ticket, deps.policy)) throw new NotFoundError();
    }
  }

  if (deps.requireCleanScan && a.scanStatus !== "clean") throw new ConflictError("This file has not been scanned yet and cannot be downloaded.", { code: "attachment_not_scanned" });
  if (a.scanStatus === "infected") throw new NotFoundError();

  const obj = await deps.storage.get(a.storageKey);
  if (!obj) {
    logger.error("attachment object missing from storage", { attachmentId: a.id });
    throw new NotFoundError();
  }

  await writeAudit(deps.db, {
    action: "attachment.download",
    actorType: "user",
    actorEmployeeId: actor.employeeId,
    entityType: "attachment",
    entityId: a.id,
    ticketId: a.ticketId,
    requestId: ctx.requestId,
    changes: { sizeBytes: a.sizeBytes },
  });
  return { body: obj.body, contentType: a.contentType, fileName: a.fileName, sizeBytes: a.sizeBytes };
}

/** Soft-delete: the uploader while the file is still staged, or an agent+ who can see the ticket. The object is purged later by cleanup. */
export async function softDeleteAttachment(deps: AttachmentDeps, actor: Actor, id: string): Promise<void> {
  const a = await deps.db.attachment.findUnique({
    where: { id },
    include: { ticket: { select: { requesterEmployeeId: true, createdByEmployeeId: true, assigneeEmployeeId: true, assignmentGroupId: true } } },
  });
  if (!a || a.status === "deleted") throw new NotFoundError();
  const own = a.status === "staged" && a.uploadedByEmployeeId === actor.employeeId;
  const agent = a.ticket !== null && (can(actor.role, "ticket.note.internal") && canViewTicket(actor, a.ticket, deps.policy));
  if (!own && !agent) throw new NotFoundError();
  await deps.db.$transaction(async (tx) => {
    await tx.attachment.update({ where: { id }, data: { status: "deleted", deletedAt: (deps.clock ?? systemClock).now() } });
    await writeAudit(tx, { action: "attachment.delete", actorType: "user", actorEmployeeId: actor.employeeId, entityType: "attachment", entityId: id, ticketId: a.ticketId });
  });
}

export interface CleanupResult {
  stagedRemoved: number;
  deletedPurged: number;
}

/**
 * Job `attachments.cleanup`: remove staged uploads older than 24 h (object + row) and purge soft-deleted attachments older than
 * the retention period ([OPEN], 30 days). An object that cannot be deleted keeps its row so the next run retries.
 */
export async function cleanupAttachments(deps: Pick<AttachmentDeps, "db" | "storage" | "clock">, limit = 200): Promise<CleanupResult> {
  const now = (deps.clock ?? systemClock).now();
  const result: CleanupResult = { stagedRemoved: 0, deletedPurged: 0 };

  const stale = await deps.db.attachment.findMany({ where: { status: "staged", createdAt: { lt: new Date(now.getTime() - STAGED_TTL_MS) } }, take: limit, select: { id: true, storageKey: true } });
  for (const row of stale) {
    try {
      await deps.storage.delete(row.storageKey);
      await deps.db.attachment.deleteMany({ where: { id: row.id, status: "staged" } });
      result.stagedRemoved += 1;
    } catch (err) {
      logger.error("could not clean up staged attachment", { attachmentId: row.id, error: err });
    }
  }

  const gone = await deps.db.attachment.findMany({ where: { status: "deleted", deletedAt: { lt: new Date(now.getTime() - DELETED_RETENTION_MS) }, NOT: { storageKey: { startsWith: "purged/" } } }, take: limit, select: { id: true, storageKey: true } });
  for (const row of gone) {
    try {
      await deps.storage.delete(row.storageKey);
      // The metadata row is kept (it is referenced by history); only the bytes are purged.
      await deps.db.attachment.update({ where: { id: row.id }, data: { storageKey: `purged/${row.id}` } });
      result.deletedPurged += 1;
    } catch (err) {
      logger.error("could not purge deleted attachment", { attachmentId: row.id, error: err });
    }
  }
  return result;
}
