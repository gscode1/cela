import { describe, expect, it, vi } from "vitest";
import type { RunOutcome } from "../src/failure.ts";
import { RunWatcher } from "../src/watcher.ts";
import type { Settlement, Watched } from "../src/watcher.ts";

const watched: Watched = { sessionId: "s1", conversationId: 7, requestId: "42" };

function make(settlements: (Settlement | Error)[]) {
  const ended: { watched: Watched; outcome: RunOutcome }[] = [];
  const done: Watched[] = [];
  const errors: unknown[] = [];
  let calls = 0;
  const watcher = new RunWatcher({
    settle: () => {
      const next = settlements[Math.min(calls, settlements.length - 1)];
      calls += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    onUnanswered: (w, outcome) => {
      ended.push({ watched: w, outcome });
      return Promise.resolve();
    },
    onDone: (w) => {
      done.push(w);
      return Promise.resolve();
    },
    onError: (error) => errors.push(error),
    retryMs: 1,
  });
  return { watcher, ended, done, errors, calls: () => calls };
}

describe("RunWatcher heartbeat (issue #333)", () => {
  it("beats while the submission is unsettled and stops once it settles", async () => {
    const gate = Promise.withResolvers<Settlement>();
    const beats: Watched[] = [];
    const watcher = new RunWatcher({
      settle: () => gate.promise,
      onUnanswered: () => Promise.resolve(),
      heartbeat: (w) => {
        beats.push(w);
        return Promise.resolve();
      },
      heartbeatMs: 5,
    });
    watcher.add(watched);
    await vi.waitFor(() => expect(beats.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(beats[0]).toEqual(watched);
    gate.resolve({ status: "done" });
    await watcher.idle();
    const after = beats.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(beats.length).toBe(after);
  }, 5_000);

  it("reports a failed beat to onError and keeps beating", async () => {
    const gate = Promise.withResolvers<Settlement>();
    const errors: unknown[] = [];
    let calls = 0;
    const watcher = new RunWatcher({
      settle: () => gate.promise,
      onUnanswered: () => Promise.resolve(),
      heartbeat: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("db down")) : Promise.resolve();
      },
      heartbeatMs: 5,
      onError: (e) => errors.push(e),
    });
    watcher.add(watched);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(errors).toHaveLength(1);
    gate.resolve({ status: "done" });
    await watcher.idle();
  }, 5_000);
});

describe("RunWatcher", () => {
  it("reports an unanswered submission once, with the reason and the error text", async () => {
    const { watcher, ended, done } = make([
      { status: "unanswered", reason: "model_error", detail: "401 Unauthorized" },
    ]);
    watcher.add(watched);
    expect(watcher.size).toBe(1);
    await watcher.idle();
    expect(ended).toEqual([
      { watched, outcome: { reason: "model_error", detail: "401 Unauthorized" } },
    ]);
    expect(done).toEqual([]);
    expect(watcher.size).toBe(0);
  });

  it("calls onDone for an answered submission, and nothing for one Pi Durable does not know", async () => {
    const answered = make([{ status: "done" }]);
    answered.watcher.add(watched);
    await answered.watcher.idle();
    expect(answered.done).toEqual([watched]);
    expect(answered.ended).toEqual([]);
    const unknown = make([undefined]);
    unknown.watcher.add(watched);
    await unknown.watcher.idle();
    expect(unknown.done).toEqual([]);
    expect(unknown.ended).toEqual([]);
  });

  it("retries through a storage error instead of losing the run", async () => {
    const { watcher, ended, errors } = make([
      new Error("connection lost"),
      { status: "unanswered", reason: "model_error", detail: "403" },
    ]);
    watcher.add(watched);
    await watcher.idle();
    expect(errors).toHaveLength(1);
    expect(ended).toHaveLength(1);
  });

  it("retries a handler that failed, so the failure is not lost", async () => {
    let failures = 1;
    const ended: Watched[] = [];
    const watcher = new RunWatcher({
      settle: () => Promise.resolve({ status: "unanswered", reason: "turn_limit" }),
      onUnanswered: (w) => {
        if (failures-- > 0) return Promise.reject(new Error("db down"));
        ended.push(w);
        return Promise.resolve();
      },
      retryMs: 1,
    });
    watcher.add(watched);
    await watcher.idle();
    expect(ended).toEqual([watched]);
  });

  it("stringifies a structured detail", async () => {
    const { watcher, ended } = make([
      { status: "unanswered", reason: "turn_limit", detail: { turns: 3 } },
    ]);
    watcher.add(watched);
    await watcher.idle();
    expect(ended[0]?.outcome.detail).toBe('{"turns":3}');
  });

  it("watches a submission once however often it is added", async () => {
    const { watcher, calls } = make([{ status: "done" }]);
    watcher.add(watched);
    watcher.add({ ...watched });
    expect(watcher.size).toBe(1);
    await watcher.idle();
    expect(calls()).toBe(1);
  });

  it("stops retrying once stopped, and adds nothing after", async () => {
    const { watcher, errors, calls } = make([new Error("closed")]);
    watcher.add(watched);
    await new Promise((resolve) => setTimeout(resolve, 20));
    watcher.stop();
    await watcher.idle();
    const after = calls();
    expect(errors.length).toBeGreaterThan(0);
    watcher.add({ ...watched, requestId: "43" });
    expect(watcher.size).toBe(0);
    expect(calls()).toBe(after);
  });
});

describe("RunWatcher with a stalled handler", () => {
  it("still handles another watch while one handler has not finished", async () => {
    const stalled = Promise.withResolvers<undefined>();
    const handled: string[] = [];
    const watcher = new RunWatcher({
      settle: () => Promise.resolve({ status: "unanswered", reason: "aborted" }),
      onUnanswered: async (w) => {
        handled.push(w.requestId);
        if (w.requestId === "slow") await stalled.promise;
      },
    });
    watcher.add({ sessionId: "a", conversationId: 1, requestId: "slow" });
    watcher.add({ sessionId: "b", conversationId: 2, requestId: "fast" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handled).toEqual(["slow", "fast"]);
    expect(watcher.size).toBe(1);
    stalled.resolve(undefined);
    await watcher.idle();
    expect(handled).toEqual(["slow", "fast"]);
  }, 5_000);
});
