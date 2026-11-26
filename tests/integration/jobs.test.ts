import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildHandlers } from "@/modules/jobs/handlers";
import { backoffMs, runDueJobs, type HandlerRegistry } from "@/modules/jobs/runner";
import { defaultSchedules, runDueSchedules, type ScheduleDef } from "@/modules/jobs/schedules";
import { fixedClock } from "@/platform/clock";
import { DatabaseStorage } from "@/modules/attachments/providers/databaseStorage";
import { FakeDirectoryProvider } from "@/modules/directory/fakeDirectoryProvider";
import { dirUser } from "../support/directoryUsers";
import { disconnect, resetDatabase, testPrisma } from "./setup";

const prisma = testPrisma();
beforeEach(async () => { await resetDatabase(prisma); });
afterAll(async () => { await disconnect(); });

const T = new Date("2026-03-04T12:00:00Z");
const enqueue = (n: number, over: Record<string, unknown> = {}) =>
  prisma.job.createMany({ data: Array.from({ length: n }, (_, i) => ({ kind: "test.job", payload: { i }, runAfter: new Date(T.getTime() - 1000), ...over })) });
const run = (handlers: HandlerRegistry, owner: string, over: object = {}) => runDueJobs({ db: prisma, handlers, owner, clock: fixedClock(T), ...over });
const ok = (counter: { n: number[] }): HandlerRegistry => ({ "test.job": async (j) => { counter.n.push((j.payload as { i: number }).i); } });

describe("runner: claiming", () => {
  it("two runners at the same time process every job exactly once", async () => {
    await enqueue(60);
    const seen = { n: [] as number[] };
    const slow: HandlerRegistry = { "test.job": async (j) => { await new Promise((r) => setTimeout(r, 2)); seen.n.push((j.payload as { i: number }).i); } };
    const [a, b] = await Promise.all([run(slow, "runner-a", { maxJobs: 100 }), run(slow, "runner-b", { maxJobs: 100 })]);
    expect(a.succeeded + b.succeeded).toBe(60);
    expect(a.succeeded).toBeGreaterThan(0);
    expect(b.succeeded).toBeGreaterThan(0); // the work really was shared
    expect(seen.n.length).toBe(60);
    expect(new Set(seen.n).size).toBe(60); // no job ran twice
    expect(await prisma.job.count({ where: { status: "succeeded" } })).toBe(60);
    expect(await prisma.job.count({ where: { status: { not: "succeeded" } } })).toBe(0);
  });

  it("four runners, 200 jobs: still once each", async () => {
    await enqueue(200);
    const seen = { n: [] as number[] };
    await Promise.all(["a", "b", "c", "d"].map((o) => run(ok(seen), o, { maxJobs: 200 })));
    expect(seen.n.length).toBe(200);
    expect(new Set(seen.n).size).toBe(200);
  });

  it("respects runAfter and ignores jobs that are not yet due", async () => {
    await enqueue(2, { runAfter: new Date(T.getTime() + 60_000) });
    await enqueue(1);
    const seen = { n: [] as number[] };
    expect((await run(ok(seen), "a")).succeeded).toBe(1);
    expect(await prisma.job.count({ where: { status: "queued" } })).toBe(2);
  });

  it("only claims kinds it has a handler for: other kinds stay queued untouched (no lost notifications)", async () => {
    await prisma.job.createMany({ data: [{ kind: "notify.ticket_created", payload: {}, runAfter: new Date(T.getTime() - 1000) }] });
    await enqueue(1);
    const seen = { n: [] as number[] };
    const r = await run(ok(seen), "a");
    expect(r.claimed).toBe(1);
    const left = await prisma.job.findFirstOrThrow({ where: { kind: "notify.ticket_created" } });
    expect(left).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("honours maxJobs", async () => {
    await enqueue(10);
    const seen = { n: [] as number[] };
    const r = await run(ok(seen), "a", { maxJobs: 4 });
    expect(r.claimed).toBe(4);
    expect(await prisma.job.count({ where: { status: "queued" } })).toBe(6);
  });

  it("stops starting new jobs once the time budget is spent", async () => {
    await enqueue(20);
    const slow: HandlerRegistry = { "test.job": async () => { await new Promise((r) => setTimeout(r, 40)); } };
    const r = await run(slow, "a", { maxJobs: 20, budgetMs: 60, batchSize: 1 });
    expect(r.claimed).toBeGreaterThan(0);
    expect(r.claimed).toBeLessThan(20);
  });

  it("processes jobs oldest-due first", async () => {
    await prisma.job.createMany({ data: [
      { kind: "test.job", payload: { i: 2 }, runAfter: new Date(T.getTime() - 1000) },
      { kind: "test.job", payload: { i: 1 }, runAfter: new Date(T.getTime() - 5000) },
    ] });
    const seen = { n: [] as number[] };
    await run(ok(seen), "a", { batchSize: 1 });
    expect(seen.n).toEqual([1, 2]);
  });
});

describe("runner: failure handling", () => {
  const failing: HandlerRegistry = { "test.job": async () => { throw new Error("smtp down"); } };

  it("a failed job is requeued with exponential backoff and the error recorded", async () => {
    await enqueue(1);
    const r = await run(failing, "a");
    expect(r).toMatchObject({ retried: 1, dead: 0 });
    const j = await prisma.job.findFirstOrThrow();
    expect(j).toMatchObject({ status: "queued", attempts: 1, lastError: "smtp down", lockedBy: null });
    expect(j.runAfter.getTime()).toBe(T.getTime() + backoffMs(1));
  });

  it("is not retried before its backoff elapses, then is retried with a longer delay", async () => {
    await enqueue(1);
    await run(failing, "a");
    expect((await run(failing, "a")).claimed).toBe(0); // same instant: not due
    const later = { clock: fixedClock(new Date(T.getTime() + backoffMs(1) + 1)) };
    await runDueJobs({ db: prisma, handlers: failing, owner: "a", ...later });
    const j = await prisma.job.findFirstOrThrow();
    expect(j.attempts).toBe(2);
    expect(j.runAfter.getTime()).toBe(T.getTime() + backoffMs(1) + 1 + backoffMs(2));
  });

  it("becomes dead after maxAttempts and is never claimed again", async () => {
    await enqueue(1, { maxAttempts: 3 });
    let clockMs = T.getTime();
    for (let i = 0; i < 6; i++) {
      await runDueJobs({ db: prisma, handlers: failing, owner: "a", clock: fixedClock(new Date(clockMs)) });
      clockMs += 2 * 60 * 60_000; // jump past any backoff
    }
    const j = await prisma.job.findFirstOrThrow();
    expect(j).toMatchObject({ status: "dead", attempts: 3, lastError: "smtp down" });
    expect(j.completedAt).not.toBeNull();
  });

  it("a job that succeeds on a later attempt is recorded as succeeded and clears the error", async () => {
    await enqueue(1);
    let n = 0;
    const flaky: HandlerRegistry = { "test.job": async () => { if (++n === 1) throw new Error("first time fails"); } };
    await runDueJobs({ db: prisma, handlers: flaky, owner: "a", clock: fixedClock(T) });
    await runDueJobs({ db: prisma, handlers: flaky, owner: "a", clock: fixedClock(new Date(T.getTime() + 61_000)) });
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ status: "succeeded", attempts: 2, lastError: null });
  });

  it("one failing job does not stop the others in the batch", async () => {
    await enqueue(3);
    let i = 0;
    const mixed: HandlerRegistry = { "test.job": async () => { if (i++ === 1) throw new Error("middle one fails"); } };
    const r = await run(mixed, "a", { batchSize: 5 });
    expect(r).toMatchObject({ succeeded: 2, retried: 1 });
  });

  it("long error messages are truncated, never unbounded", async () => {
    await enqueue(1);
    await run({ "test.job": async () => { throw new Error("x".repeat(5000)); } }, "a");
    expect((await prisma.job.findFirstOrThrow()).lastError!.length).toBe(1000);
  });
});

describe("runner: leases and crashed runners", () => {
  it("a job whose lease expired (crashed runner) is claimed again; a live lease is not stolen", async () => {
    await prisma.job.createMany({ data: [
      { kind: "test.job", payload: { i: 1 }, status: "running", attempts: 1, lockedBy: "dead-runner", lockedUntil: new Date(T.getTime() - 1000), runAfter: new Date(T.getTime() - 5000) },
      { kind: "test.job", payload: { i: 2 }, status: "running", attempts: 1, lockedBy: "live-runner", lockedUntil: new Date(T.getTime() + 60_000), runAfter: new Date(T.getTime() - 5000) },
    ] });
    const seen = { n: [] as number[] };
    await run(ok(seen), "rescuer");
    expect(seen.n).toEqual([1]);
    const live = await prisma.job.findFirstOrThrow({ where: { lockedBy: "live-runner" } });
    expect(live.status).toBe("running");
  });

  it("an abandoned job that already used its last attempt is dead-lettered, not run again", async () => {
    await prisma.job.create({ data: { kind: "test.job", payload: {}, status: "running", attempts: 8, maxAttempts: 8, lockedBy: "gone", lockedUntil: new Date(T.getTime() - 1000), runAfter: new Date(T.getTime() - 5000) } });
    const seen = { n: [] as number[] };
    const r = await run(ok(seen), "a");
    expect(seen.n).toEqual([]);
    expect(r.dead).toBe(1);
    expect((await prisma.job.findFirstOrThrow()).status).toBe("dead");
  });

  it("a runner that lost its claim cannot overwrite the new owner's result", async () => {
    await enqueue(1);
    let stolen = false;
    const slow: HandlerRegistry = {
      "test.job": async (j) => {
        // while 'a' is working, its lease "expires" and runner 'b' takes the job over
        await prisma.job.update({ where: { id: j.id }, data: { lockedBy: "b", lockedUntil: new Date(T.getTime() + 999_999) } });
        stolen = true;
      },
    };
    await run(slow, "a");
    expect(stolen).toBe(true);
    const j = await prisma.job.findFirstOrThrow();
    expect(j.status).toBe("running"); // 'a' did not mark it finished
    expect(j.lockedBy).toBe("b");
  });
});

describe("schedules: slot lease", () => {
  const defs: ScheduleDef[] = [{ name: "sla.evaluate", intervalMs: 60_000, enabled: true }, { name: "ticket.autoclose", intervalMs: 3_600_000, enabled: true }, { name: "off", intervalMs: 60_000, enabled: false }];
  const jobs = () => prisma.job.findMany({ orderBy: { dedupeKey: "asc" } });

  it("many runners in the same slot produce exactly one job per schedule", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => runDueSchedules(prisma, defs, fixedClock(T))));
    expect(results.flat().sort()).toEqual(["sla.evaluate", "ticket.autoclose"]); // each fired once across all runners
    expect((await jobs()).map((j) => j.kind).sort()).toEqual(["sla.evaluate", "ticket.autoclose"]);
  });

  it("the next slot fires again, and a repeat within the same slot does nothing", async () => {
    await runDueSchedules(prisma, defs, fixedClock(T));
    expect(await runDueSchedules(prisma, defs, fixedClock(new Date(T.getTime() + 30_000)))).toEqual([]);
    expect(await runDueSchedules(prisma, defs, fixedClock(new Date(T.getTime() + 61_000)))).toEqual(["sla.evaluate"]);
    expect(await prisma.job.count({ where: { kind: "sla.evaluate" } })).toBe(2);
    expect(await prisma.job.count({ where: { kind: "ticket.autoclose" } })).toBe(1); // hourly: not due yet
  });

  it("a missed stretch fires once, not once per missed slot", async () => {
    await runDueSchedules(prisma, defs, fixedClock(T));
    await runDueSchedules(prisma, defs, fixedClock(new Date(T.getTime() + 10 * 60_000)));
    expect(await prisma.job.count({ where: { kind: "sla.evaluate" } })).toBe(2);
  });

  it("disabled schedules never fire, and the stored slot is recorded", async () => {
    await runDueSchedules(prisma, defs, fixedClock(T));
    expect(await prisma.job.count({ where: { kind: "off" } })).toBe(0);
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { name: "sla.evaluate" } })).lastSlotAt?.toISOString()).toBe("2026-03-04T12:00:00.000Z");
  });

  it("does not disturb the directory delta cursor stored on the same row", async () => {
    await prisma.jobSchedule.create({ data: { name: "directory.delta", cursor: "https://graph.microsoft.com/v1.0/users/delta?$deltatoken=abc" } });
    await runDueSchedules(prisma, defaultSchedules({ directorySyncEnabled: true }), fixedClock(T));
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { name: "directory.delta" } })).cursor).toContain("deltatoken=abc");
  });
});

describe("handlers end to end through the runner", () => {
  const handlers = (over: object = {}) => buildHandlers({ db: prisma, clock: fixedClock(T), storage: () => new DatabaseStorage(prisma), directory: () => null, ...over });

  it("a scheduled sla.evaluate job runs and a due-schedule + runner pass drains it", async () => {
    await runDueSchedules(prisma, defaultSchedules({ directorySyncEnabled: false }), fixedClock(T));
    const r = await runDueJobs({ db: prisma, handlers: handlers(), owner: "a", clock: fixedClock(T) });
    expect(r.succeeded).toBe(3); // sla.evaluate, ticket.autoclose, attachments.cleanup
    expect(await prisma.job.count({ where: { status: "succeeded" } })).toBe(3);
  });

  it("directory jobs call the provider when Graph is configured, and are skipped (not failed) when it is not", async () => {
    const provider = new FakeDirectoryProvider([dirUser(), dirUser()]);
    await prisma.job.createMany({ data: [{ kind: "directory.full", payload: {}, runAfter: new Date(T.getTime() - 1000) }] });
    await runDueJobs({ db: prisma, handlers: handlers({ directory: () => ({ provider, eligibility: { excludeUpnPrefixes: ["svc-"] } }) }), owner: "a", clock: fixedClock(T) });
    expect(await prisma.employee.count()).toBe(2);
    await prisma.job.create({ data: { kind: "directory.delta", payload: {}, runAfter: new Date(T.getTime() - 1000) } });
    const r = await runDueJobs({ db: prisma, handlers: handlers(), owner: "a", clock: fixedClock(T) });
    expect(r.succeeded).toBe(1);
  });
});
