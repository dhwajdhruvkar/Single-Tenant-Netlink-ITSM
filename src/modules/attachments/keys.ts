import { randomUUID } from "node:crypto";

// Storage keys are namespaced by environment so staging and production can never collide in a shared bucket, and are validated
// strictly so a key can never be used for path traversal or to reach another namespace.

export type KeyEnv = "local" | "staging" | "production";

const KEY_PATTERN = /^itsm\/(local|staging|production)\/att\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** APP_ENV `test` shares the `local` namespace. */
export function keyEnvFor(appEnv: string): KeyEnv {
  return appEnv === "production" ? "production" : appEnv === "staging" ? "staging" : "local";
}

export function makeStorageKey(env: KeyEnv, now: Date, id: string = randomUUID()): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `itsm/${env}/att/${yyyy}/${mm}/${id}`;
  assertValidKey(key);
  return key;
}

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function assertValidKey(key: string): void {
  if (!isValidKey(key)) throw new Error("Invalid storage key");
}
