import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { stageAttachment } from "@/modules/attachments/service";
import { DatabaseStorage } from "@/modules/attachments/providers/databaseStorage";
import { readAttachment } from "@/modules/attachments/service";
import { changeStatus } from "@/modules/tickets/changeStatus";
import { getTicketDetail } from "@/modules/tickets/detail";
import { addMessage } from "@/modules/tickets/messages";
import { fixedClock } from "@/platform/clock";
import { disconnect, resetDatabase, testPrisma } from "./setup";
import { PDF } from "../support/files";
import { world } from "../support/world";

const prisma = testPrisma();
const W = world(prisma);
const storage = new DatabaseStorage(prisma);
const adeps = { db: prisma, storage, keyEnv: "local" as const, maxBytes: 4 * 1024 * 1024 };

beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const msg = (a: Parameters<typeof addMessage>[1], ref: string, body: string, visibility: "public" | "internal" = "public", attachmentIds: string[] = [], deps: object = {}) =>
  addMessage({ db: prisma, ...deps }, a, ref, { body, visibility, attachmentIds });

const SECRET_NOTE = "INTERNAL-ONLY: customer is a flight risk, escalate quietly";

async function scene() {
  const g = await W.group("Desk");
  const requester = await W.actor("employee", [], { displayName: "Rita Requester" });
  const agent = await W.actor("agent", [g], { displayName: "Alan Agent" });
  const t = await W.ticket({ requester, group: g.id });
  return { g, requester, agent, t };
}

describe("internal notes never reach employees", () => {
  it("the raw detail JSON for the requester contains no trace of an internal note, its event, or its attachment", async () => {
    const { requester, agent, t } = await scene();
    const file = await stageAttachment(adeps, agent, { fileName: "secret-plan.pdf", declaredType: "application/pdf", bytes: PDF });
    await msg(agent, t.reference, SECRET_NOTE, "internal", [file.id]);
    await msg(agent, t.reference, "We are looking into it.", "public");

    const forRequester = JSON.stringify(await getTicketDetail(prisma, requester, t.reference));
    expect(forRequester).toContain("We are looking into it.");
    for (const leak of [SECRET_NOTE, "flight risk", "secret-plan.pdf", "internal_note_added", file.id, '"internal"']) {
      expect(forRequester, `leaked: ${leak}`).not.toContain(leak);
    }

    const forAgent = JSON.stringify(await getTicketDetail(prisma, agent, t.reference));
    expect(forAgent).toContain(SECRET_NOTE);
    expect(forAgent).toContain("secret-plan.pdf");
    expect(forAgent).toContain("internal_note_added");
  });

  it("the attachment download refuses the requester (404) but serves the agent", async () => {
    const { requester, agent, t } = await scene();
    const file = await stageAttachment(adeps, agent, { fileName: "secret-plan.pdf", declaredType: "application/pdf", bytes: PDF });
    await msg(agent, t.reference, SECRET_NOTE, "internal", [file.id]);
    await expect(readAttachment({ ...adeps }, requester, file.id)).rejects.toMatchObject({ status: 404 });
    await expect(readAttachment({ ...adeps }, agent, file.id)).resolves.toBeDefined();
  });

  it("agent-written free-text reasons on status changes are visible to agents only", async () => {
    const { requester, agent, t } = await scene();
    await changeStatus({ db: prisma }, agent, t.reference, { version: 0, to: "on_hold", holdReason: "awaiting_vendor", reason: "Supplier says the part is DOA, we are being charged twice" });
    expect(JSON.stringify(await getTicketDetail(prisma, requester, t.reference))).not.toContain("charged twice");
    expect(JSON.stringify(await getTicketDetail(prisma, agent, t.reference))).toContain("charged twice");
  });

  it("an employee cannot post an internal note (403) even on their own ticket, and nothing is written", async () => {
    const { requester, t } = await scene();
    await expect(msg(requester, t.reference, "sneaky", "internal")).rejects.toMatchObject({ status: 403 });
    expect(await prisma.ticketMessage.count()).toBe(0);
  });

  it("a submitter (creator) cannot see internal notes either", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const submitter = await W.actor("submitter");
    const t = await W.ticket({ requester: await W.actor("employee"), createdBy: submitter, group: g.id });
    await msg(agent, t.reference, SECRET_NOTE, "internal");
    expect(JSON.stringify(await getTicketDetail(prisma, submitter, t.reference))).not.toContain("flight risk");
  });

  it("the notification job for an internal note is marked internal, so recipients can be chosen safely", async () => {
    const { agent, t } = await scene();
    const m = await msg(agent, t.reference, SECRET_NOTE, "internal");
    const job = await prisma.job.findFirstOrThrow({ where: { kind: "notify.ticket_message" } });
    expect(job.payload).toMatchObject({ ticketId: t.id, messageId: m.id, visibility: "internal" });
    expect(JSON.stringify(job.payload)).not.toContain("flight risk"); // the body is never copied into the job
  });
});

describe("posting messages", () => {
  it("the requester and an agent can converse; authors and kinds are recorded", async () => {
    const { requester, agent, t } = await scene();
    await msg(requester, t.reference, "My screen is black");
    await msg(agent, t.reference, "Have you tried restarting?");
    const d = (await getTicketDetail(prisma, requester, t.reference))!;
    expect(d.messages.map((m) => [m.authorName, m.authorKind, m.visibility])).toEqual([["Rita Requester", "employee", "public"], ["Alan Agent", "agent", "public"]]);
  });

  it("the first public agent reply records firstRespondedAt; internal notes and the requester's own messages do not", async () => {
    const { requester, agent, t } = await scene();
    await msg(requester, t.reference, "Hello?");
    await msg(agent, t.reference, "Private thought", "internal");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt).toBeNull();
    await msg(agent, t.reference, "On it", "public", [], { clock: fixedClock("2026-03-04T15:00:00Z") });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt?.toISOString()).toBe("2026-03-04T15:00:00.000Z");
    await msg(agent, t.reference, "Update", "public", [], { clock: fixedClock("2026-03-04T18:00:00Z") });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt?.toISOString()).toBe("2026-03-04T15:00:00.000Z"); // unchanged
  });

  it("an agent replying on a ticket they themselves requested does not count as a response", async () => {
    const g = await W.group("Desk");
    const agent = await W.actor("agent", [g]);
    const t = await W.ticket({ requester: agent, group: g.id });
    await msg(agent, t.reference, "Note to self");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt).toBeNull();
  });

  it("a reply on an awaiting_requester hold returns the ticket to in_progress; other holds are untouched", async () => {
    const { g, requester } = await scene();
    const waiting = await W.ticket({ requester, group: g.id, status: "on_hold", holdReason: "awaiting_requester" });
    const vendor = await W.ticket({ requester, group: g.id, status: "on_hold", holdReason: "awaiting_vendor" });
    expect((await msg(requester, waiting.reference, "Here you go")).status).toBe("in_progress");
    expect((await msg(requester, vendor.reference, "Any news?")).status).toBe("on_hold");
    expect(await prisma.ticket.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "in_progress", holdReason: null, version: 1 });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: vendor.id } })).version).toBe(0);
  });

  it("an agent's reply does not resume an awaiting_requester hold", async () => {
    const { g, agent, requester } = await scene();
    const t = await W.ticket({ requester, group: g.id, status: "on_hold", holdReason: "awaiting_requester" });
    expect((await msg(agent, t.reference, "Still waiting for your logs")).status).toBe("on_hold");
  });

  it("closed and cancelled tickets accept no messages (409); strangers get 404", async () => {
    const { g, agent, requester } = await scene();
    const closed = await W.ticket({ requester, group: g.id, status: "closed" });
    await expect(msg(requester, closed.reference, "late")).rejects.toMatchObject({ status: 409 });
    await expect(msg(agent, closed.reference, "late", "internal")).rejects.toMatchObject({ status: 409 });
    const open = await W.ticket({ requester, group: g.id });
    await expect(msg(await W.actor("employee"), open.reference, "hi")).rejects.toMatchObject({ status: 404 });
  });

  it("a resolved ticket still accepts a requester reply (it does not silently reopen)", async () => {
    const { g, requester } = await scene();
    const t = await W.ticket({ requester, group: g.id, status: "resolved", resolvedAt: new Date() });
    expect((await msg(requester, t.reference, "Thanks!")).status).toBe("resolved");
  });

  it("validates the body: trimmed, non-empty, at most 10,000 characters (contract)", async () => {
    const { MessageInput } = await import("@/modules/tickets/messages");
    expect(MessageInput.safeParse({ body: "   " }).success).toBe(false);
    expect(MessageInput.safeParse({ body: "x".repeat(10001) }).success).toBe(false);
    expect(MessageInput.safeParse({ body: "ok", visibility: "secret" }).success).toBe(false);
    expect(MessageInput.safeParse({ body: "ok", requesterEmployeeId: "x" }).success).toBe(false);
    expect(MessageInput.parse({ body: " hi " })).toMatchObject({ body: "hi", visibility: "public", attachmentIds: [] });
  });

  it("stores markup as plain text (rendering escapes it), unicode intact", async () => {
    const { requester, t } = await scene();
    await msg(requester, t.reference, "<script>alert(1)</script> Привет 👋");
    expect((await prisma.ticketMessage.findFirstOrThrow()).body).toBe("<script>alert(1)</script> Привет 👋");
  });

  it("links the sender's staged attachments to the message in the same transaction; someone else's roll the message back", async () => {
    const { requester, agent, t } = await scene();
    const mine = await stageAttachment(adeps, requester, { fileName: "log.pdf", declaredType: "application/pdf", bytes: PDF });
    const theirs = await stageAttachment(adeps, agent, { fileName: "other.pdf", declaredType: "application/pdf", bytes: PDF });
    await expect(msg(requester, t.reference, "with someone else's file", "public", [theirs.id])).rejects.toMatchObject({ code: "ATTACHMENT_INVALID" });
    expect(await prisma.ticketMessage.count()).toBe(0);
    const m = await msg(requester, t.reference, "my log", "public", [mine.id]);
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ status: "linked", ticketId: t.id, messageId: m.id });
    expect((await getTicketDetail(prisma, requester, t.reference))!.messages[0].attachments.map((a) => a.fileName)).toEqual(["log.pdf"]);
  });

  it("removed messages show as removed with no body", async () => {
    const { requester, t } = await scene();
    const m = await msg(requester, t.reference, "oops, wrong ticket");
    await prisma.ticketMessage.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    const d = (await getTicketDetail(prisma, requester, t.reference))!;
    expect(d.messages[0]).toMatchObject({ removed: true, body: "" });
    expect(JSON.stringify(d)).not.toContain("wrong ticket");
  });
});

describe("detail: actions mirror what the server will allow", () => {
  const actions = async (who: Parameters<typeof getTicketDetail>[1], ref: string) => (await getTicketDetail(prisma, who, ref))!.actions;

  it("per role on a new ticket in the agent's queue", async () => {
    const g = await W.group("Desk");
    const requester = await W.actor("employee");
    const agent = await W.actor("agent", [g]);
    const manager = await W.actor("manager");
    const t = await W.ticket({ requester, group: g.id });
    expect(await actions(requester, t.reference)).toEqual({ statuses: ["cancelled"], canAssign: false, canEdit: false, canArchive: false, canReply: true, canNote: false });
    expect(await actions(agent, t.reference)).toEqual({ statuses: ["in_progress", "on_hold", "resolved", "cancelled"], canAssign: true, canEdit: true, canArchive: false, canReply: true, canNote: true });
    expect((await actions(manager, t.reference)).canArchive).toBe(true);
  });

  it("a resolved ticket offers the requester confirm and reopen (inside the window)", async () => {
    const g = await W.group("Desk");
    const requester = await W.actor("employee");
    const t = await W.ticket({ requester, group: g.id, status: "resolved", resolvedAt: new Date() });
    expect((await actions(requester, t.reference)).statuses.sort()).toEqual(["closed", "in_progress"]);
    const old = await W.ticket({ requester, group: g.id, status: "resolved", resolvedAt: new Date(Date.now() - 30 * 86_400_000) });
    expect((await actions(requester, old.reference)).statuses).toEqual(["closed"]);
  });

  it("final tickets offer nothing", async () => {
    const requester = await W.actor("employee");
    const t = await W.ticket({ requester, status: "closed" });
    expect(await actions(requester, t.reference)).toEqual({ statuses: [], canAssign: false, canEdit: false, canArchive: false, canReply: false, canNote: false });
  });
});
