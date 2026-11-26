import { describe, expect, it, vi } from "vitest";
import { withRetry, withTimeout } from "@/platform/resilience";

const noSleep = async () => {};

describe("withRetry", () => {
  it("retries then succeeds", async () => {
    let n = 0;
    const out = await withRetry(async () => { if (++n < 3) throw new Error("x"); return "ok"; }, { step: "t", sleep: noSleep });
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });
  it("returns null and calls onFailure after the last attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    const out = await withRetry(async () => { throw new Error("boom"); }, { step: "t", attempts: 2, sleep: noSleep, onFailure });
    expect(out).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

describe("withTimeout", () => {
  it("rejects slow work", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "slow")).rejects.toThrow(/slow timed out/);
  });
  it("passes through fast work", async () => {
    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toBe(1);
  });
});
