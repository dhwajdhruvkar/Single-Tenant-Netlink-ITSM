import { describe, expect, it, vi } from "vitest";
import { BACKOFF_CAP_MS, backoffMs } from "@/modules/jobs/runner";
import { defaultSchedules, slotStart } from "@/modules/jobs/schedules";
import { addWorkingDays } from "@/modules/tickets/autoClose";
import { assertCronAuthorized } from "@/platform/http/cronAuth";
import { runWorker } from "@/platform/workerLoop";

describe("backoffMs", () => {
  it("is 1 minute doubling per attempt, capped at 1 hour", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(backoffMs(7)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(50)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(0)).toBe(60_000);
  });
});

describe("schedules", () => {
  it("has the roadmap's schedule table, and directory sync follows configuration", () => {
    const on = Object.fromEntries(defaultSchedules({ directorySyncEnabled: true }).map((s) => [s.name, s.intervalMs / 60_000]));
    expect(on).toEqual({ "sla.evaluate": 1, "ticket.autoclose": 60, "attachments.cleanup": 1440, "directory.delta": 30, "directory.full": 1440 });
    const off = defaultSchedules({ directorySyncEnabled: false });
    expect(off.filter((s) => !s.enabled).map((s) => s.name).sort()).toEqual(["directory.delta", "directory.full"]);
    expect(off.filter((s) => s.enabled).length).toBe(3);
  });
  it("slots are aligned to the epoch, so every runner agrees on them", () => {
    expect(slotStart(new Date("2026-03-04T15:00:42.500Z"), 60_000).toISOString()).toBe("2026-03-04T15:00:00.000Z");
    expect(slotStart(new Date("2026-03-04T15:29:59.999Z"), 30 * 60_000).toISOString()).toBe("2026-03-04T15:00:00.000Z");
    expect(slotStart(new Date("2026-03-04T15:30:00.000Z"), 30 * 60_000).toISOString()).toBe("2026-03-04T15:30:00.000Z");
  });
});

describe("addWorkingDays", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 16);
  it("counts Monday to Friday only", () => {
    expect(iso(addWorkingDays(new Date("2026-03-02T10:00:00Z"), 5))).toBe("2026-03-09T10:00"); // Mon + 5 = next Mon
    expect(iso(addWorkingDays(new Date("2026-03-06T10:00:00Z"), 1))).toBe("2026-03-09T10:00"); // Fri + 1 = Mon
    expect(iso(addWorkingDays(new Date("2026-03-07T10:00:00Z"), 1))).toBe("2026-03-09T10:00"); // Sat + 1 = Mon
    expect(iso(addWorkingDays(new Date("2026-03-04T10:00:00Z"), 0))).toBe("2026-03-04T10:00");
    expect(iso(addWorkingDays(new Date("2026-03-04T10:00:00Z"), 10))).toBe("2026-03-18T10:00");
  });
});

describe("assertCronAuthorized", () => {
  const SECRET = "s".repeat(32);
  const req = (auth?: string) => new Request("http://x/api/internal/jobs/run", { headers: auth ? { authorization: auth } : {} });
  it("accepts the exact bearer secret", () => expect(() => assertCronAuthorized(req(`Bearer ${SECRET}`), SECRET)).not.toThrow());
  it("rejects a missing, wrong, malformed or differently-cased credential with 401", () => {
    for (const h of [undefined, "Bearer ", "Bearer wrong", `Bearer ${SECRET}x`, SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`, `Bearer  ${SECRET}`]) {
      expect(() => assertCronAuthorized(req(h), SECRET), String(h)).toThrow(expect.objectContaining({ status: 401 }));
    }
  });
  it("is closed when no secret is configured or it is shorter than 32 characters, even if the caller presents exactly that value", () => {
    expect(() => assertCronAuthorized(req("Bearer short"), "short")).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => assertCronAuthorized(req("Bearer "), "")).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => assertCronAuthorized(req("Bearer anything"), undefined)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => assertCronAuthorized(req(`Bearer ${"s".repeat(31)}`), "s".repeat(31))).toThrow(expect.objectContaining({ status: 401 }));
  });
  it("never reveals which part was wrong", () => {
    const msgs = new Set<string>();
    for (const h of [undefined, "Bearer wrong"]) { try { assertCronAuthorized(req(h), SECRET); } catch (e) { msgs.add((e as Error).message); } }
    expect(msgs.size).toBe(1);
  });
});

describe("runWorker", () => {
  it("ticks repeatedly, survives a failing tick, and stops promptly on abort", async () => {
    const abort = new AbortController();
    let n = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tick = vi.fn(async () => { n += 1; if (n === 2) throw new Error("boom"); if (n === 4) abort.abort(); });
    await runWorker({ intervalMs: 5, signal: abort.signal, tick });
    expect(tick).toHaveBeenCalledTimes(4);
  });
  it("an abort during the wait ends the loop without another tick", async () => {
    const abort = new AbortController();
    const tick = vi.fn(async () => {});
    const p = runWorker({ intervalMs: 60_000, signal: abort.signal, tick });
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await p;
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it("lets the tick in progress finish before stopping", async () => {
    const abort = new AbortController();
    let finished = false;
    const p = runWorker({ intervalMs: 10, signal: abort.signal, tick: async () => { abort.abort(); await new Promise((r) => setTimeout(r, 30)); finished = true; } });
    await p;
    expect(finished).toBe(true);
  });
});
