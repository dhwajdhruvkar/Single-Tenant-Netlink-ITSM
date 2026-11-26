import type { ObjectStorage, StorageProviderName, StoredObjectBody } from "../ports";
import { StorageUnavailableError } from "../ports";

/**
 * Placeholder for providers that are not implemented yet (S3-compatible, Azure Blob). They need verification against a real service
 * or emulator (MinIO/Azurite), which has not been possible, so selecting one fails loudly (503) instead of running untested code.
 */
export class UnavailableStorage implements ObjectStorage {
  constructor(readonly provider: StorageProviderName) {}
  private fail(): never {
    throw new StorageUnavailableError(`The "${this.provider}" storage provider is not implemented yet. Use STORAGE_PROVIDER=database until it is.`);
  }
  async put(): Promise<void> { return this.fail(); }
  async get(): Promise<StoredObjectBody | null> { return this.fail(); }
  async delete(): Promise<boolean> { return this.fail(); }
  async exists(): Promise<boolean> { return this.fail(); }
}
