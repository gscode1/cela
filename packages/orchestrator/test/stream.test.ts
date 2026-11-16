import { describe, expect, it } from "vitest";
import { liveEvent, parseLastEventId } from "../src/stream.ts";

describe("parseLastEventId", () => {
  it("reads a positive integer and treats everything else as no cursor", () => {
    expect(parseLastEventId("17")).toBe(17);
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("-3")).toBe(0);
    expect(parseLastEventId("1.5")).toBe(0);
  });
});

describe("liveEvent", () => {
  it("is idle without a run and an empty inbox", () => {
    expect(liveEvent({})).toEqual({ running: false, queued: 0 });
  });

  it("reports the run, the queue, the partial answer and the tool calls", () => {
    const event = liveEvent({
      "pi.live": {
        run: { taskId: 1 },
        generation: {
          attempt: 1,
          message: {
            content: [
              { type: "text", text: "par" },
              { type: "text", text: "tial" },
            ],
          },
        },
        tools: [{ callId: "c1", name: "bash", status: "running" }],
      },
      "pi.inbox": { items: [{ id: 1 }, { id: 2 }] },
    });
    expect(event).toEqual({
      running: true,
      queued: 2,
      partial: "partial",
      tools: [{ callId: "c1", name: "bash", status: "running" }],
    });
  });

  it("surfaces why the newest run ended without an answer", () => {
    expect(liveEvent({ "pi.live": { runFailure: { reason: "aborted" } } })).toMatchObject({
      running: false,
      runFailure: "aborted",
    });
  });
});
