import type { AppConfig } from "./env";

// Single place where provider names are resolved. Concrete adapters are added by the phase that owns the port
// (storage P6, email P9, directory P4); modules never import a provider SDK directly.

export type StorageProviderName = AppConfig["STORAGE_PROVIDER"];
export type EmailProviderName = AppConfig["EMAIL_PROVIDER"];

export function selectedProviders(cfg: Pick<AppConfig, "STORAGE_PROVIDER" | "EMAIL_PROVIDER">) {
  return { storage: cfg.STORAGE_PROVIDER, email: cfg.EMAIL_PROVIDER } as const;
}
