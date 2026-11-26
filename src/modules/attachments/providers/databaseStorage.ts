import type { PrismaClient } from "@prisma/client";
import { assertValidKey } from "../keys";
import type { ObjectStorage, StoredObjectBody } from "../ports";

// TEMPORARY provider: bytes live in the same Postgres database (StoredObject table), like the original app. It is capped at 4 MB per
// file and will not scale; move to object storage before production volumes (Doc E).

export class DatabaseStorage implements ObjectStorage {
  readonly provider = "database" as const;
  constructor(private readonly db: Pick<PrismaClient, "storedObject">) {}

  async put(key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    assertValidKey(key);
    await this.db.storedObject.upsert({
      where: { key },
      create: { key, contentType: opts.contentType, data: new Uint8Array(body) },
      update: { contentType: opts.contentType, data: new Uint8Array(body) },
    });
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    assertValidKey(key);
    const row = await this.db.storedObject.findUnique({ where: { key } });
    return row ? { body: Buffer.from(row.data), contentType: row.contentType } : null;
  }

  async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    const r = await this.db.storedObject.deleteMany({ where: { key } });
    return r.count > 0;
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    return (await this.db.storedObject.count({ where: { key } })) > 0;
  }
}
