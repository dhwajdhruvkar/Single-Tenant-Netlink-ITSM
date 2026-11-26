import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/actor";
import type { AppRole } from "@/modules/identity/roleMapping";
import { DatabaseStorage } from "@/modules/attachments/providers/databaseStorage";
import { cleanupAttachments, DELETED_RETENTION_MS, linkStagedAttachments, readAttachment, softDeleteAttachment, stageAttachment, STAGED_TTL_MS, type AttachmentDeps } from "@/modules/attachments/service";
import { createTicket } from "@/modules/tickets/createTicket";
import { fixedClock } from "@/platform/clock";
import { allocateTicketNumber, formatReference } from "@/modules/tickets/reference";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { PDF, PNG } from "../support/files";

const prisma = testPrisma();
const storage = new DatabaseStorage(prisma);
const deps = (over: Partial<AttachmentDeps> = {}): AttachmentDeps => ({ db: prisma, storage, keyEnv: "local", maxBytes: 4 * 1024 * 1024, ...over });

beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

let n = 0;
async function actorOf(role: AppRole, groupIds: string[] = [], triage: string[] = []): Promise<Actor> {
  const e = await prisma.employee.create({ data: { entraObjectId: randomUUID(), userPrincipalName: `u${++n}@example.test`, displayName: `U${n}` } });
  const a = await prisma.userAccount.create({ data: { employeeId: e.id, role } });
  return { employeeId: e.id, userAccountId: a.id, role, groupIds, triageGroupIds: triage };
}

const upload = (actor: Actor, over: Partial<{ fileName: string; declaredType: string; bytes: Buffer }> = {}, d = deps()) =>
  stageAttachment(d, actor, { fileName: "shot.png", declaredType: "image/png", bytes: PNG, ...over });

async function ticketFor(requester: Actor, creator: Actor = requester, group: string | null = null) {
  const number = await allocateTicketNumber(prisma);
  return prisma.ticket.create({
    data: { number, reference: formatReference("incident", number), type: "incident", channel: "portal", subject: "s", description: "d", impact: "medium", urgency: "medium", priority: "p3", requesterName: "r", requesterEmployeeId: requester.employeeId, createdByEmployeeId: creator.employeeId, assignmentGroupId: group },
  });
}
async function linked(uploader: Actor, ticketId: string, messageVisibility?: "public" | "internal") {
  const staged = await upload(uploader);
  let messageId: string | null = null;
  if (messageVisibility) {
    messageId = (await prisma.ticketMessage.create({ data: { ticketId, authorKind: "agent", authorEmployeeId: uploader.employeeId, visibility: messageVisibility, body: "b" } })).id;
  }
  await prisma.$transaction((tx) => linkStagedAttachments(tx, { actorEmployeeId: uploader.employeeId, ids: [staged.id], ticketId, messageId, now: new Date() }));
  return staged.id;
}

describe("stageAttachment", () => {
  it("stores the object under an itsm/ key and records metadata with a sha256", async () => {
    const actor = await actorOf("employee");
    const dto = await upload(actor);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.storageKey).toMatch(/^itsm\/local\/att\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(row).toMatchObject({ status: "staged", storageProvider: "database", ticketId: null, uploadedByEmployeeId: actor.employeeId, scanStatus: "not_scanned", sizeBytes: PNG.length, contentType: "image/png" });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.compare((await storage.get(row.storageKey))!.body, PNG)).toBe(0);
  });

  it("rejects an EXE, a PNG renamed to PDF, and oversize files, leaving nothing behind", async () => {
    const actor = await actorOf("employee");
    await expect(upload(actor, { fileName: "x.exe", declaredType: "application/octet-stream", bytes: Buffer.from("MZ" + "0".repeat(10)) })).rejects.toThrow(/not allowed/);
    await expect(upload(actor, { fileName: "x.pdf", declaredType: "application/pdf", bytes: PNG })).rejects.toThrow(/does not match/);
    await expect(upload(actor, { bytes: Buffer.alloc(100, 1) }, deps({ maxBytes: 10 }))).rejects.toMatchObject({ status: 413 });
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.storedObject.count()).toBe(0);
  });

  it("removes the stored object if the metadata insert fails (no orphaned bytes)", async () => {
    const actor = await actorOf("employee");
    const broken = { ...prisma, attachment: { create: async () => { throw new Error("db down"); } } } as unknown as typeof prisma;
    await expect(stageAttachment(deps({ db: broken }), actor, { fileName: "a.png", declaredType: "image/png", bytes: PNG })).rejects.toThrow(/db down/);
    expect(await prisma.storedObject.count()).toBe(0);
  });

  it("rejects a file the scanner reports as infected, and records a scanner result otherwise", async () => {
    const actor = await actorOf("employee");
    await expect(upload(actor, {}, deps({ scanner: { scan: async () => "infected" } }))).rejects.toThrow(/malware/);
    expect(await prisma.storedObject.count()).toBe(0);
    const ok = await upload(actor, {}, deps({ scanner: { scan: async () => "clean" } }));
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: ok.id } })).scanStatus).toBe("clean");
  });

  it("a scanner crash is recorded as 'failed', not a silent pass", async () => {
    const actor = await actorOf("employee");
    const dto = await upload(actor, {}, deps({ scanner: { scan: async () => { throw new Error("icap down"); } } }));
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: dto.id } })).scanStatus).toBe("failed");
  });
});

describe("linking staged attachments", () => {
  const link = (actor: Actor, ids: string[], ticketId: string, now = new Date()) => prisma.$transaction((tx) => linkStagedAttachments(tx, { actorEmployeeId: actor.employeeId, ids, ticketId, now }));

  it("links the uploader's own staged files to a ticket", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const a = await upload(me);
    await link(me, [a.id], t.id);
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "linked", ticketId: t.id });
  });

  it("refuses someone else's staged attachment with a uniform 422 and links nothing", async () => {
    const me = await actorOf("employee");
    const other = await actorOf("employee");
    const t = await ticketFor(me);
    const mine = await upload(me);
    const theirs = await upload(other);
    await expect(link(me, [mine.id, theirs.id], t.id)).rejects.toMatchObject({ status: 422, code: "ATTACHMENT_INVALID" });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("staged"); // whole link rolled back
  });

  it("refuses an already-linked, unknown or expired attachment (same error for each)", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const a = await upload(me);
    await link(me, [a.id], t.id);
    await expect(link(me, [a.id], t.id)).rejects.toMatchObject({ code: "ATTACHMENT_INVALID" });
    await expect(link(me, [randomUUID()], t.id)).rejects.toMatchObject({ code: "ATTACHMENT_INVALID" });
    const old = await upload(me, {}, deps({ clock: fixedClock(new Date(Date.now() - STAGED_TTL_MS - 60_000)) }));
    await expect(link(me, [old.id], t.id)).rejects.toMatchObject({ code: "ATTACHMENT_INVALID" });
  });

  it("rejects more than 10 attachments and duplicate ids", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    await expect(link(me, Array.from({ length: 11 }, () => randomUUID()), t.id)).rejects.toMatchObject({ status: 400 });
    const a = await upload(me);
    await expect(link(me, [a.id, a.id], t.id)).rejects.toMatchObject({ status: 400 });
  });

  it("two concurrent claims of the same attachment: exactly one wins", async () => {
    const me = await actorOf("employee");
    const t1 = await ticketFor(me);
    const t2 = await ticketFor(me);
    const a = await upload(me);
    const results = await Promise.allSettled([link(me, [a.id], t1.id), link(me, [a.id], t2.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("createTicket with attachments", () => {
  const cmd = (attachmentIds: string[]) => ({ type: "incident" as const, subject: "Screenshot attached", description: "See image", attachmentIds, requester: { kind: "self" as const }, channel: "portal" as const });

  it("links the staged files atomically with the ticket", async () => {
    const me = await actorOf("employee");
    const a = await upload(me);
    const b = await upload(me, { fileName: "doc.pdf", declaredType: "application/pdf", bytes: PDF });
    const { ticket } = await createTicket({ db: prisma }, me, cmd([a.id, b.id]));
    const rows = await prisma.attachment.findMany({ where: { ticketId: ticket.id } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "linked" && r.linkedAt)).toBe(true);
    expect((await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id } })).data).toMatchObject({ attachmentCount: 2 });
  });

  it("someone else's staged attachment is a 422 and NO ticket is created", async () => {
    const me = await actorOf("employee");
    const other = await actorOf("employee");
    const theirs = await upload(other);
    await expect(createTicket({ db: prisma }, me, cmd([theirs.id]))).rejects.toMatchObject({ status: 422, code: "ATTACHMENT_INVALID" });
    expect(await prisma.ticket.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("staged");
  });

  it("an attachment cannot be reused on a second ticket", async () => {
    const me = await actorOf("employee");
    const a = await upload(me);
    await createTicket({ db: prisma }, me, cmd([a.id]));
    await expect(createTicket({ db: prisma }, me, cmd([a.id]))).rejects.toMatchObject({ code: "ATTACHMENT_INVALID" });
    expect(await prisma.ticket.count()).toBe(1);
  });

  it("more than 10 attachments is a 400", async () => {
    const me = await actorOf("employee");
    await expect(createTicket({ db: prisma }, me, cmd(Array.from({ length: 11 }, () => randomUUID())))).rejects.toMatchObject({ status: 400 });
  });

  it("a replayed (idempotent) create does not try to link again", async () => {
    const me = await actorOf("employee");
    const a = await upload(me);
    const c = { ...cmd([a.id]), idempotencyKey: "attach-key-0001" };
    const first = await createTicket({ db: prisma }, me, c);
    const again = await createTicket({ db: prisma }, me, c);
    expect(again.replayed).toBe(true);
    expect(again.ticket.id).toBe(first.ticket.id);
  });
});

describe("download authorization (404, never 403)", () => {
  const dl = (actor: Actor, id: string, over: Partial<AttachmentDeps> = {}) => readAttachment(deps(over), actor, id);

  it("the requester and the creator can download; an unrelated employee gets 404", async () => {
    const requester = await actorOf("employee");
    const agent = await actorOf("agent");
    const stranger = await actorOf("employee");
    const t = await ticketFor(requester, agent);
    const id = await linked(requester, t.id);
    expect((await dl(requester, id)).fileName).toBe("shot.png");
    expect((await dl(agent, id)).body.length).toBe(PNG.length); // creator
    await expect(dl(stranger, id)).rejects.toMatchObject({ status: 404 });
  });

  it("an agent can download only for tickets in their queue", async () => {
    const group = await prisma.assignmentGroup.create({ data: { name: "Desk" } });
    const requester = await actorOf("employee");
    const inGroup = await actorOf("agent", [group.id]);
    const outsider = await actorOf("agent");
    const t = await ticketFor(requester, requester, group.id);
    const id = await linked(requester, t.id);
    await expect(dl(inGroup, id)).resolves.toBeDefined();
    await expect(dl(outsider, id)).rejects.toMatchObject({ status: 404 });
  });

  it("attachments on an INTERNAL message are hidden from the requester (404) but visible to agents", async () => {
    const group = await prisma.assignmentGroup.create({ data: { name: "Desk" } });
    const requester = await actorOf("employee");
    const agent = await actorOf("agent", [group.id]);
    const t = await ticketFor(requester, requester, group.id);
    const internalFile = await linked(agent, t.id, "internal");
    const publicFile = await linked(agent, t.id, "public");
    await expect(dl(requester, internalFile)).rejects.toMatchObject({ status: 404 });
    await expect(dl(agent, internalFile)).resolves.toBeDefined();
    await expect(dl(requester, publicFile)).resolves.toBeDefined();
  });

  it("a staged file is visible to its uploader only", async () => {
    const me = await actorOf("employee");
    const agent = await actorOf("manager");
    const a = await upload(me);
    await expect(dl(me, a.id)).resolves.toBeDefined();
    await expect(dl(agent, a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("managers see any ticket's attachments; archived tickets and deleted files are 404", async () => {
    const requester = await actorOf("employee");
    const manager = await actorOf("manager");
    const t = await ticketFor(requester);
    const id = await linked(requester, t.id);
    await expect(dl(manager, id)).resolves.toBeDefined();
    await prisma.ticket.update({ where: { id: t.id }, data: { archivedAt: new Date() } });
    await expect(dl(manager, id)).rejects.toMatchObject({ status: 404 });
    await prisma.ticket.update({ where: { id: t.id }, data: { archivedAt: null } });
    await prisma.attachment.update({ where: { id }, data: { status: "deleted", deletedAt: new Date() } });
    await expect(dl(manager, id)).rejects.toMatchObject({ status: 404 });
  });

  it("malformed ids are 404, not a database error", async () => {
    const me = await actorOf("employee");
    for (const id of ["nope", "../../x", "", "1".repeat(200)]) await expect(dl(me, id)).rejects.toMatchObject({ status: 404 });
  });

  it("every successful download is audited, and failures are not", async () => {
    const requester = await actorOf("employee");
    const stranger = await actorOf("employee");
    const t = await ticketFor(requester);
    const id = await linked(requester, t.id);
    await dl(requester, id);
    await expect(dl(stranger, id)).rejects.toBeDefined();
    const rows = await prisma.auditLog.findMany({ where: { action: "attachment.download" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorEmployeeId: requester.employeeId, entityId: id, ticketId: t.id });
  });

  it("[OPEN] requireCleanScan: only files scanned clean can be downloaded", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const id = await linked(me, t.id);
    await expect(dl(me, id, { requireCleanScan: true })).rejects.toMatchObject({ status: 409 });
    await prisma.attachment.update({ where: { id }, data: { scanStatus: "clean" } });
    await expect(dl(me, id, { requireCleanScan: true })).resolves.toBeDefined();
  });

  it("an infected file is never served, and a missing object is 404", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const id = await linked(me, t.id);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
    await storage.delete(row.storageKey);
    await expect(dl(me, id)).rejects.toMatchObject({ status: 404 });
    await prisma.attachment.update({ where: { id }, data: { scanStatus: "infected" } });
    await expect(dl(me, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("softDeleteAttachment", () => {
  it("the uploader can delete a staged file; others cannot", async () => {
    const me = await actorOf("employee");
    const other = await actorOf("employee");
    const a = await upload(me);
    await expect(softDeleteAttachment(deps(), other, a.id)).rejects.toMatchObject({ status: 404 });
    await softDeleteAttachment(deps(), me, a.id);
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "deleted" });
    await expect(readAttachment(deps(), me, a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("an employee cannot delete a linked file, an agent who can see the ticket can", async () => {
    const group = await prisma.assignmentGroup.create({ data: { name: "Desk" } });
    const requester = await actorOf("employee");
    const agent = await actorOf("agent", [group.id]);
    const t = await ticketFor(requester, requester, group.id);
    const id = await linked(requester, t.id);
    await expect(softDeleteAttachment(deps(), requester, id)).rejects.toMatchObject({ status: 404 });
    await softDeleteAttachment(deps(), agent, id);
    expect(await prisma.auditLog.count({ where: { action: "attachment.delete" } })).toBe(1);
  });
});

describe("cleanup job", () => {
  it("removes staged uploads older than 24h (object and row) and keeps fresh ones and linked ones", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const old = await upload(me, {}, deps({ clock: fixedClock(new Date(Date.now() - STAGED_TTL_MS - 3600_000)) }));
    const fresh = await upload(me);
    const keep = await linked(me, t.id);
    const oldKey = (await prisma.attachment.findUniqueOrThrow({ where: { id: old.id } })).storageKey;
    const r = await cleanupAttachments(deps());
    expect(r.stagedRemoved).toBe(1);
    expect(await prisma.attachment.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await storage.exists(oldKey)).toBe(false);
    expect(await prisma.attachment.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await prisma.attachment.findUnique({ where: { id: keep } })).not.toBeNull();
  });

  it("purges bytes of long-deleted attachments, keeps the metadata row, and does not reprocess them", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const id = await linked(me, t.id);
    const key = (await prisma.attachment.findUniqueOrThrow({ where: { id } })).storageKey;
    await prisma.attachment.update({ where: { id }, data: { status: "deleted", deletedAt: new Date(Date.now() - DELETED_RETENTION_MS - 3600_000) } });
    expect((await cleanupAttachments(deps())).deletedPurged).toBe(1);
    expect(await storage.exists(key)).toBe(false);
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "deleted" });
    expect((await cleanupAttachments(deps())).deletedPurged).toBe(0); // idempotent
  });

  it("recently deleted attachments are retained", async () => {
    const me = await actorOf("employee");
    const t = await ticketFor(me);
    const id = await linked(me, t.id);
    await prisma.attachment.update({ where: { id }, data: { status: "deleted", deletedAt: new Date() } });
    expect((await cleanupAttachments(deps())).deletedPurged).toBe(0);
  });

  it("a storage failure keeps the row so the next run retries", async () => {
    const me = await actorOf("employee");
    const old = await upload(me, {}, deps({ clock: fixedClock(new Date(Date.now() - STAGED_TTL_MS - 3600_000)) }));
    const failing = { provider: "database", put: storage.put.bind(storage), get: storage.get.bind(storage), exists: storage.exists.bind(storage), delete: async () => { throw new Error("storage down"); } } as unknown as DatabaseStorage;
    expect((await cleanupAttachments({ db: prisma, storage: failing })).stagedRemoved).toBe(0);
    expect(await prisma.attachment.findUnique({ where: { id: old.id } })).not.toBeNull();
    expect((await cleanupAttachments(deps())).stagedRemoved).toBe(1);
  });
});
