import { logger } from "@/platform/logging/logger";

// Retry with exponential backoff. Failures are surfaced to the caller via onFailure (e.g. an audit/job writer
// supplied by the owning module), never swallowed silently.

export interface RetryOptions {
  step: string;
  attempts?: number;
  baseDelayMs?: number;
  onFailure?: (error: unknown) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns the result, or null after the final attempt fails. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T | null> {
  const attempts = options.attempts ?? 3;
  const baseDelay = options.baseDelayMs ?? 150;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      logger.warn(`${options.step} attempt failed`, {
        step: options.step,
        attempt,
        attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt < attempts) await sleep(baseDelay * 2 ** (attempt - 1));
    }
  }
  logger.error(`${options.step} failed after ${attempts} attempts`, { step: options.step, error: lastError });
  try {
    await options.onFailure?.(lastError);
  } catch (hookErr) {
    logger.error("failure hook threw", { step: options.step, error: hookErr });
  }
  return null;
}

/** Reject if the promise does not settle within ms. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
