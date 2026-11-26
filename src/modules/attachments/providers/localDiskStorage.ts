import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertValidKey } from "../keys";
import type { ObjectStorage, StoredObjectBody } from "../ports";
import { StorageUnavailableError } from "../ports";

/** DEVELOPMENT ONLY: files on the local disk. Refuses to run in production. */
export class LocalDiskStorage implements ObjectStorage {
  readonly provider = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    if (process.env.NODE_ENV === "production") throw new StorageUnavailableError("The local disk storage provider is for development only.");
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertValidKey(key);
    const full = resolve(join(this.root, ...key.split("/")));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid storage key"); // belt and braces
    return full;
  }

  async put(key: string, body: Buffer, opts: { contentType: string }): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.meta`, opts.contentType, "utf8");
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const file = this.path(key);
    try {
      const [body, contentType] = await Promise.all([readFile(file), readFile(`${file}.meta`, "utf8").catch(() => "application/octet-stream")]);
      return { body, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    const file = this.path(key);
    const existed = await this.exists(key);
    await rm(file, { force: true });
    await rm(`${file}.meta`, { force: true });
    return existed;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}
