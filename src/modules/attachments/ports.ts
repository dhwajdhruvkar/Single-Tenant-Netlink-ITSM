// Storage and scanning ports. Core logic never imports a cloud SDK; concrete providers live in ./providers.

export type StorageProviderName = "database" | "s3" | "azure_blob" | "local";

export interface StoredObjectBody {
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  readonly provider: StorageProviderName;
  put(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  /** null when the key does not exist. */
  get(key: string): Promise<StoredObjectBody | null>;
  /** true if something was deleted. Deleting a missing key is not an error. */
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export type ScanOutcome = "not_scanned" | "clean" | "infected" | "failed";

export interface MalwareScanner {
  scan(fileName: string, body: Buffer): Promise<ScanOutcome>;
}

/** Default: no scanner is configured [EXTERNAL], so files are recorded as not_scanned. */
export const noopScanner: MalwareScanner = { async scan() { return "not_scanned"; } };

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}
