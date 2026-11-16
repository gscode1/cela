import { describe, expect, it } from "vitest";
import {
  claimNameFor,
  conversationOfName,
  interruptedExec,
  planSuspend,
} from "../src/lifecycle.ts";

describe("interruptedExec", () => {
  it("is true for an aborted or timed-out command and for a call that threw", () => {
    expect(
      interruptedExec({ threw: false, result: { ok: false, error: { code: "aborted" } } }),
    ).toBe(true);
    expect(
      interruptedExec({ threw: false, result: { ok: false, error: { code: "timeout" } } }),
    ).toBe(true);
    expect(interruptedExec({ threw: true })).toBe(true);
  });

  it("is false for a command that ended by itself, whatever its exit code, and for other failures", () => {
    expect(interruptedExec({ threw: false, result: { ok: true, value: { exitCode: 0 } } })).toBe(
      false,
    );
    expect(interruptedExec({ threw: false, result: { ok: true, value: { exitCode: 137 } } })).toBe(
      false,
    );
    expect(
      interruptedExec({ threw: false, result: { ok: false, error: { code: "spawn_error" } } }),
    ).toBe(false);
    expect(interruptedExec({ threw: false, result: undefined })).toBe(false);
  });
});

describe("conversationOfName", () => {
  it("reads pi-conv-<n> and nothing else", () => {
    expect(conversationOfName(0, "pi-conv-5858")).toBe(5858);
    for (const name of ["e2e-phase1", "pi-conv-", "pi-conv-1a", "xpi-conv-1", "pi-conv-1-x"]) {
      expect(conversationOfName(0, name)).toBeUndefined();
    }
  });

  it("reads only the names of its own shard", () => {
    expect(conversationOfName(1, "pi-s1-conv-5")).toBe(5);
    expect(conversationOfName(0, "pi-s1-conv-5")).toBeUndefined();
    expect(conversationOfName(1, "pi-conv-5")).toBeUndefined();
    expect(conversationOfName(1, "pi-s11-conv-5")).toBeUndefined();
    expect(conversationOfName(2, "pi-s1-conv-5")).toBeUndefined();
  });
});

describe("claimNameFor", () => {
  it("keeps shard 0's name and gives every other shard its own", () => {
    expect(claimNameFor(0, 42)).toBe("pi-conv-42");
    expect(claimNameFor(1, 42)).toBe("pi-s1-conv-42");
    expect(claimNameFor(12, 42)).toBe("pi-s12-conv-42");
  });

  it("never gives two shards the same name for the same conversation id", () => {
    const names = new Set<string>();
    for (let shard = 0; shard < 30; shard++)
      for (const id of [2, 3, 42]) names.add(claimNameFor(shard, id));
    expect(names.size).toBe(30 * 3);
  });

  it("round-trips through conversationOfName and is a valid object name", () => {
    for (const shard of [0, 1, 9, 10]) {
      const name = claimNameFor(shard, 7);
      expect(conversationOfName(shard, name)).toBe(7);
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
  });
});

describe("planSuspend", () => {
  const MIN = 60_000;
  const now = 1_000_000_000;
  const base = { shard: 0, now, afterMs: 30 * MIN, busy: new Set<number>() };

  it("suspends a sandbox idle for at least the threshold, not a younger one", () => {
    const plan = planSuspend({
      ...base,
      running: ["pi-conv-1", "pi-conv-2", "pi-conv-3"],
      lastUsed: new Map([
        [1, now - 30 * MIN],
        [2, now - 29 * MIN],
        [3, now - 90 * MIN],
      ]),
    });
    expect(plan).toEqual({ seen: [], suspend: [1, 3] });
  });

  it("starts the clock at first sight for a sandbox it has no record of (after an orchestrator restart)", () => {
    const plan = planSuspend({ ...base, running: ["pi-conv-7"], lastUsed: new Map() });
    expect(plan).toEqual({ seen: [7], suspend: [] });
  });

  it("never suspends a busy conversation, however idle its record says", () => {
    const plan = planSuspend({
      ...base,
      busy: new Set([1]),
      running: ["pi-conv-1"],
      lastUsed: new Map([[1, now - 600 * MIN]]),
    });
    expect(plan).toEqual({ seen: [], suspend: [] });
  });

  it("only considers conversation sandboxes", () => {
    const plan = planSuspend({
      ...base,
      running: ["e2e-phase1", "sample-session", "pi-conv-4"],
      lastUsed: new Map([[4, now - 60 * MIN]]),
    });
    expect(plan).toEqual({ seen: [], suspend: [4] });
  });

  it("does nothing when suspension is off (afterMs 0)", () => {
    const plan = planSuspend({
      ...base,
      afterMs: 0,
      running: ["pi-conv-1"],
      lastUsed: new Map([[1, 0]]),
    });
    expect(plan).toEqual({ seen: [], suspend: [] });
  });
});

describe("planSuspend: shards", () => {
  it("ignores the sandboxes of another shard", () => {
    const plan = planSuspend({
      shard: 0,
      now: 1_000_000,
      afterMs: 1,
      busy: new Set(),
      running: ["pi-s1-conv-5", "pi-conv-6"],
      lastUsed: new Map([
        [5, 0],
        [6, 0],
      ]),
    });
    expect(plan.suspend).toEqual([6]);
    const other = planSuspend({
      shard: 1,
      now: 1_000_000,
      afterMs: 1,
      busy: new Set(),
      running: ["pi-s1-conv-5", "pi-conv-6"],
      lastUsed: new Map([
        [5, 0],
        [6, 0],
      ]),
    });
    expect(other.suspend).toEqual([5]);
  });
});
