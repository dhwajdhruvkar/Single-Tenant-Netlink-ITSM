import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeStorageKey } from "@/modules/attachments/keys";
import { DatabaseStorage } from "@/modules/attachments/providers/databaseStorage";
import { LocalDiskStorage } from "@/modules/attachments/providers/localDiskStorage";
import { UnavailableStorage } from "@/modules/attachments/providers/unavailableStorage";
import { StorageUnavailableError, type ObjectStorage } from "@/modules/attachments/ports";
import { PNG } from "../support/files";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
const roots: string[] = [];
const key = () => makeStorageKey("local", new Date("2026-03-09T10:00:00Z"), randomUUID());

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  await disconnect();
});

// One contract, every provider. An S3/Azure provider added later must pass this same suite (against MinIO/Azurite).
const providers: Array<[string, () => Promise<ObjectStorage>]> = [
  ["database", async () => new DatabaseStorage(prisma)],
  ["local disk", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir("storage-local", { recursive: true }));
    const dir = await mkdtemp(join("storage-local", "test-"));
    roots.push(dir);
    return new LocalDiskStorage(dir);
  }],
];

describe.each(providers)("ObjectStorage contract: %s", (_name, make) => {
  it("round-trips bytes and content type exactly", async () => {
    const s = await make();
    const k = key();
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 128, 13, 10]);
    await s.put(k, binary, { contentType: "application/pdf" });
    const got = await s.get(k);
    expect(got?.contentType).toBe("application/pdf");
    expect(Buffer.compare(got!.body, binary)).toBe(0);
  });

  it("round-trips a real image without corruption", async () => {
    const s = await make();
    const k = key();
    await s.put(k, PNG, { contentType: "image/png" });
    expect(Buffer.compare((await s.get(k))!.body, PNG)).toBe(0);
  });

  it("get returns null and exists returns false for a missing key", async () => {
    const s = await make();
    expect(await s.get(key())).toBeNull();
    expect(await s.exists(key())).toBe(false);
  });

  it("exists reflects put and delete, and delete reports whether anything was removed", async () => {
    const s = await make();
    const k = key();
    await s.put(k, Buffer.from("x"), { contentType: "text/plain" });
    expect(await s.exists(k)).toBe(true);
    expect(await s.delete(k)).toBe(true);
    expect(await s.exists(k)).toBe(false);
    expect(await s.get(k)).toBeNull();
    expect(await s.delete(k)).toBe(false); // deleting a missing key is not an error
  });

  it("put overwrites an existing key", async () => {
    const s = await make();
    const k = key();
    await s.put(k, Buffer.from("one"), { contentType: "text/plain" });
    await s.put(k, Buffer.from("two"), { contentType: "text/csv" });
    const got = await s.get(k);
    expect(got?.body.toString()).toBe("two");
    expect(got?.contentType).toBe("text/csv");
  });

  it("stores empty-ish and larger payloads (1 MB)", async () => {
    const s = await make();
    const k = key();
    const big = Buffer.alloc(1024 * 1024, 7);
    await s.put(k, big, { contentType: "application/octet-stream" });
    expect((await s.get(k))!.body.length).toBe(big.length);
  });

  it("keeps keys independent", async () => {
    const s = await make();
    const a = key();
    const b = key();
    await s.put(a, Buffer.from("A"), { contentType: "text/plain" });
    await s.put(b, Buffer.from("B"), { contentType: "text/plain" });
    await s.delete(a);
    expect((await s.get(b))?.body.toString()).toBe("B");
  });

  it("refuses malformed or traversal keys on every operation", async () => {
    const s = await make();
    for (const bad of ["../../etc/passwd", "itsm/local/att/2026/03/../../../x", "plain", ""]) {
      await expect(s.put(bad, Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow();
      await expect(s.get(bad)).rejects.toThrow();
      await expect(s.delete(bad)).rejects.toThrow();
      await expect(s.exists(bad)).rejects.toThrow();
    }
  });
});

describe("persistence", () => {
  it("database provider: data survives a new client (a restarted app)", async () => {
    const k = key();
    await new DatabaseStorage(prisma).put(k, Buffer.from("durable"), { contentType: "text/plain" });
    const { PrismaClient } = await import("@prisma/client");
    const fresh = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://itsm:itsm@localhost:5432/itsm_test" } } });
    try {
      expect((await new DatabaseStorage(fresh).get(k))?.body.toString()).toBe("durable");
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe("provider safety", () => {
  it("the local disk provider refuses to run in production", () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => new LocalDiskStorage("storage-local/x")).toThrow(StorageUnavailableError);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev;
    }
  });
  it("S3 and Azure are explicit 'not implemented' providers that fail loudly", async () => {
    for (const name of ["s3", "azure_blob"] as const) {
      const s = new UnavailableStorage(name);
      await expect(s.put()).rejects.toThrow(/not implemented/);
      await expect(s.get()).rejects.toBeInstanceOf(StorageUnavailableError);
    }
  });
});
