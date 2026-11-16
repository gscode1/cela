import { describe, expect, it } from "vitest";
import { conversationOfName, interruptedExec, planSuspend } from "../src/lifecycle.ts";

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
    expect(conversationOfName("pi-conv-5858")).toBe(5858);
    for (const name of ["e2e-phase1", "pi-conv-", "pi-conv-1a", "xpi-conv-1", "pi-conv-1-x"]) {
      expect(conversationOfName(name)).toBeUndefined();
    }
  });
});

describe("planSuspend", () => {
  const MIN = 60_000;
  const now = 1_000_000_000;
  const base = { now, afterMs: 30 * MIN, busy: new Set<number>() };

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
