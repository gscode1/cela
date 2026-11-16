import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/failure.ts";
import { RunWatcher } from "../src/watcher.ts";
import type { SubmissionState, Watched } from "../src/watcher.ts";

const watched: Watched = { sessionId: "s1", conversationId: 7, requestId: "42" };

function make(states: (SubmissionState | undefined)[]) {
  const ended: { watched: Watched; outcome: RunOutcome }[] = [];
  const errors: unknown[] = [];
  let calls = 0;
  const watcher = new RunWatcher({
    lookup: () => {
      const state = states[Math.min(calls, states.length - 1)];
      calls += 1;
      if (state instanceof Error) return Promise.reject(state);
      return Promise.resolve(state);
    },
    onUnanswered: (w, outcome) => {
      ended.push({ watched: w, outcome });
      return Promise.resolve();
    },
    onError: (error) => errors.push(error),
  });
  return { watcher, ended, errors };
}

describe("RunWatcher", () => {
  it("reports an unanswered submission once, with the reason and the error text", async () => {
    const { watcher, ended } = make([
      { status: "placed" },
      { status: "unanswered", reason: "model_error", detail: "401 Unauthorized" },
    ]);
    watcher.add(watched);
    await watcher.poll();
    expect(ended).toEqual([]);
    expect(watcher.size).toBe(1);
    await watcher.poll();
    await watcher.poll();
    expect(ended).toEqual([
      { watched, outcome: { reason: "model_error", detail: "401 Unauthorized" } },
    ]);
    expect(watcher.size).toBe(0);
    watcher.stop();
  });

  it("drops a submission that was answered, and one the storage does not know", async () => {
    const answered = make([{ status: "done" }]);
    answered.watcher.add(watched);
    await answered.watcher.poll();
    expect(answered.watcher.size).toBe(0);
    const unknown = make([undefined]);
    unknown.watcher.add(watched);
    await unknown.watcher.poll();
    expect(unknown.watcher.size).toBe(0);
    expect(answered.ended).toEqual([]);
    expect(unknown.ended).toEqual([]);
  });

  it("keeps watching through a storage error instead of losing the run", async () => {
    const { watcher, ended, errors } = make([
      new Error("connection lost") as unknown as SubmissionState,
      { status: "unanswered", reason: "model_error", detail: "403" },
    ]);
    watcher.add(watched);
    await watcher.poll();
    expect(errors).toHaveLength(1);
    expect(watcher.size).toBe(1);
    await watcher.poll();
    expect(ended).toHaveLength(1);
    watcher.stop();
  });

  it("stringifies a structured detail", async () => {
    const { watcher, ended } = make([
      { status: "unanswered", reason: "turn_limit", detail: { turns: 3 } },
    ]);
    watcher.add(watched);
    await watcher.poll();
    expect(ended[0]?.outcome.detail).toBe('{"turns":3}');
  });
});

describe("RunWatcher with a stalled handler", () => {
  it("still handles another watch while one handler has not finished", async () => {
    const stalled = Promise.withResolvers<undefined>();
    const handled: string[] = [];
    const watcher = new RunWatcher({
      lookup: () => Promise.resolve({ status: "unanswered", reason: "aborted" }),
      onUnanswered: async (w) => {
        handled.push(w.requestId);
        if (w.requestId === "slow") await stalled.promise;
      },
    });
    watcher.add({ sessionId: "a", conversationId: 1, requestId: "slow" });
    watcher.add({ sessionId: "b", conversationId: 2, requestId: "fast" });
    const first = watcher.poll(); // blocks on the slow handler
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handled).toEqual(["slow", "fast"]); // the lookups went on past the slow handler
    await watcher.poll(); // a later tick must not wait for it, nor run it twice
    expect(handled).toEqual(["slow", "fast"]);
    expect(watcher.size).toBe(1);
    stalled.resolve(undefined);
    await first;
    expect(watcher.size).toBe(0);
    watcher.stop();
  }, 5_000);
});
