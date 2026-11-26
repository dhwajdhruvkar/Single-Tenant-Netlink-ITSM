import { logger } from "@/platform/logging/logger";

export interface WorkerOptions {
  intervalMs: number;
  /** One unit of work. Errors are logged and the loop carries on. */
  tick: () => Promise<unknown>;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

/**
 * The worker's main loop: run a tick, wait, repeat. Aborting the signal (SIGTERM) wakes the wait immediately but lets a tick that is
 * already running finish, so a deploy never kills a job half-way through.
 */
export async function runWorker(opts: WorkerOptions): Promise<void> {
  const sleep = opts.sleep ?? abortableSleep;
  while (!opts.signal.aborted) {
    try {
      await opts.tick();
    } catch (err) {
      logger.error("worker tick failed", { error: err });
    }
    if (opts.signal.aborted) break;
    await sleep(opts.intervalMs, opts.signal);
  }
}
