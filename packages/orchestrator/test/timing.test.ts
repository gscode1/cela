import { describe, expect, it } from "vitest";
import { TurnTimings, spansOf } from "../src/timing.ts";

function setup() {
  let clock = 1_000;
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const timings = new TurnTimings(
    (event, fields) => lines.push({ event, fields }),
    () => clock,
  );
  return {
    timings,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const turn = { session: "s-1", conversation: 7, turn: "evt-1" };

describe("TurnTimings", () => {
  it("logs each phase with ms since the turn start and a summary at the first exec", () => {
    const { timings, lines, advance } = setup();
    timings.begin(turn);
    advance(20);
    timings.mark(7, "input-submitted");
    advance(2_000);
    timings.mark(7, "tool-requested");
    advance(1_000); // waiting for a bridge slot
    timings.mark(7, "claim-requested");
    timings.setState(7, "cold");
    advance(9_000);
    timings.mark(7, "claim-ready");
    timings.mark(7, "bridge-started");
    advance(12_000);
    timings.mark(7, "bridge-ready");
    advance(100);
    timings.mark(7, "first-exec-start");

    expect(lines.map((l) => l.event)).toEqual([
      "turn-phase",
      "turn-phase",
      "turn-phase",
      "turn-phase",
      "turn-phase",
      "turn-phase",
      "turn-phase",
      "turn-timing",
    ]);
    expect(lines[3]?.fields).toEqual({ ...turn, phase: "claim-ready", ms: 12_020 });
    expect(lines[7]?.fields).toEqual({
      ...turn,
      sandbox: "cold",
      phases: {
        "input-submitted": 20,
        "tool-requested": 2_020,
        "claim-requested": 3_020,
        "claim-ready": 12_020,
        "bridge-started": 12_020,
        "bridge-ready": 24_020,
        "first-exec-start": 24_120,
      },
      spans: {
        model: 2_000,
        "cap-wait": 1_000,
        claim: 9_000,
        bridge: 12_000,
        "sandbox-to-exec": 22_100,
      },
    });
  });

  it("keeps the first occurrence of a phase and forgets the turn after the summary", () => {
    const { timings, lines, advance } = setup();
    timings.begin(turn);
    timings.mark(7, "bridge-started");
    advance(50);
    timings.mark(7, "bridge-started"); // a bridge respawn
    expect(lines).toHaveLength(1);
    timings.mark(7, "first-exec-start");
    const count = lines.length;
    timings.mark(7, "first-exec-start");
    timings.mark(7, "bridge-ready");
    expect(lines).toHaveLength(count);
    expect(timings.fields(7)).toEqual({});
  });

  it("reports a warm turn with no sandbox phases, and ignores phases without a turn", () => {
    const { timings, lines, advance } = setup();
    timings.mark(7, "claim-ready");
    expect(lines).toEqual([]);
    timings.begin(turn);
    advance(5);
    timings.mark(7, "first-exec-start");
    expect(lines[1]).toMatchObject({
      event: "turn-timing",
      fields: { sandbox: "warm", phases: { "first-exec-start": 5 }, spans: {} },
    });
  });

  it("tags log lines with the current turn and restarts the clock on a new input", () => {
    const { timings, lines, advance } = setup();
    timings.begin(turn);
    expect(timings.fields(7)).toEqual({ session: "s-1", conversation: 7, turn: "evt-1" });
    advance(10_000);
    timings.begin({ ...turn, turn: "evt-2" });
    timings.setState(7, "resumed");
    advance(7);
    timings.mark(7, "first-exec-start");
    expect(lines[1]?.fields).toMatchObject({ turn: "evt-2", sandbox: "resumed" });
    expect(lines[0]?.fields).toMatchObject({ ms: 7 });
  });

  it("keeps conversations apart", () => {
    const { timings, lines } = setup();
    timings.begin(turn);
    timings.begin({ session: "s-2", conversation: 8, turn: "evt-9" });
    timings.mark(8, "first-exec-start");
    expect(lines[0]?.fields).toMatchObject({ session: "s-2", turn: "evt-9" });
    expect(timings.fields(7)).toMatchObject({ turn: "evt-1" });
  });
});

describe("startup is measured to the dispatch of the first exec", () => {
  it("does not count a long command, and keeps cap wait out of model time", () => {
    const { timings, lines, advance } = setup();
    timings.begin(turn);
    timings.mark(7, "input-submitted");
    advance(4_000);
    timings.mark(7, "tool-requested");
    advance(30_000);
    timings.mark(7, "claim-requested");
    advance(5);
    timings.mark(7, "first-exec-start");
    advance(60_000); // the command runs; nothing more is logged for it
    timings.mark(7, "first-exec-start");
    expect(lines.at(-1)?.fields).toMatchObject({
      spans: { model: 4_000, "cap-wait": 30_000, "sandbox-to-exec": 30_005 },
    });
    expect(lines.filter((l) => l.event === "turn-timing")).toHaveLength(1);
  });
});

describe("clearing", () => {
  it("clear forgets a turn without a summary", () => {
    const { timings, lines } = setup();
    timings.begin(turn);
    timings.clear(7);
    timings.mark(7, "first-exec-start");
    expect(lines).toEqual([]);
    expect(timings.fields(7)).toEqual({});
  });

  it("expires turns that never ran a tool, at the next begin", () => {
    const { timings, advance } = setup();
    timings.begin(turn);
    advance(61 * 60_000);
    timings.begin({ session: "s-2", conversation: 8, turn: "evt-2" });
    expect(timings.fields(7)).toEqual({});
    expect(timings.fields(8)).toMatchObject({ turn: "evt-2" });
  });

  it("keeps at most 1000 turns, dropping the oldest", () => {
    const { timings, advance } = setup();
    for (let i = 0; i < 1005; i++) {
      timings.begin({ session: "s", conversation: i, turn: `e${String(i)}` });
      advance(1);
    }
    expect(timings.fields(0)).toEqual({});
    expect(timings.fields(1004)).toMatchObject({ turn: "e1004" });
    expect(timings.fields(5)).toMatchObject({ turn: "e5" });
  });
});

describe("spansOf", () => {
  it("omits spans with a missing or reversed end", () => {
    expect(spansOf({ "claim-requested": 10 })).toEqual({});
    expect(spansOf({ "claim-requested": 10, "claim-ready": 5 })).toEqual({});
    expect(spansOf({ "claim-requested": 10, "claim-ready": 25 })).toEqual({ claim: 15 });
  });
});
