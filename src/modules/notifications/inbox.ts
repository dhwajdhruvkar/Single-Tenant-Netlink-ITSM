import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Actor } from "@/modules/identity/actor";

// A person's in-app inbox. Every query is scoped to the actor's own employee id: there is no way to read or mark someone else's notifications.

type Db = Pick<PrismaClient, "notification">;

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export const MarkRead = z.object({ ids: z.array(z.string().uuid()).min(1).max(100).optional(), all: z.literal(true).optional() }).strict()
  .refine((v) => (v.ids ? 1 : 0) + (v.all ? 1 : 0) === 1, { message: "Send either ids or all: true." });

export async function listNotifications(db: Db, actor: Actor, opts: { limit: number; unreadOnly: boolean }): Promise<{ data: NotificationDTO[]; unread: number }> {
  const where: Prisma.NotificationWhereInput = { recipientEmployeeId: actor.employeeId, ...(opts.unreadOnly ? { readAt: null } : {}) };
  const [rows, unread] = await Promise.all([
    db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: opts.limit }),
    db.notification.count({ where: { recipientEmployeeId: actor.employeeId, readAt: null } }),
  ]);
  return {
    data: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: n.readAt !== null, createdAt: n.createdAt.toISOString() })),
    unread,
  };
}

/** Mark some (or all) of the actor's own notifications read. Ids that are not theirs are silently ignored. */
export async function markRead(db: Db, actor: Actor, input: z.infer<typeof MarkRead>, now: Date = new Date()): Promise<{ updated: number }> {
  const r = await db.notification.updateMany({
    where: { recipientEmployeeId: actor.employeeId, readAt: null, ...(input.ids ? { id: { in: input.ids } } : {}) },
    data: { readAt: now },
  });
  return { updated: r.count };
}
