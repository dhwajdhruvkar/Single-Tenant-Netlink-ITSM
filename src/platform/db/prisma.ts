import { PrismaClient, Prisma } from "@prisma/client";

// Single Prisma client per process (avoids connection exhaustion on hot reload).
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

export type Tx = Prisma.TransactionClient;

/** Run work in one interactive transaction (entity change + event + audit + outbox rows commit together). */
export function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { timeoutMs?: number; maxWaitMs?: number },
): Promise<T> {
  return prisma.$transaction(fn, {
    timeout: options?.timeoutMs ?? 10_000,
    maxWait: options?.maxWaitMs ?? 5_000,
  });
}
