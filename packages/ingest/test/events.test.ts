import { describe, expect, it } from "vitest";
import { parseEventBody } from "../src/events.ts";

describe("parseEventBody", () => {
  it("accepts a message and keeps the client's sourceEventId", () => {
    expect(parseEventBody({ kind: "message", text: "hi", sourceEventId: "abc" })).toEqual({
      kind: "message",
      payload: { text: "hi" },
      sourceEventId: "abc",
    });
  });

  it("gives an event without sourceEventId its own id, so it is never deduplicated", () => {
    const a = parseEventBody({ kind: "steer", text: "left" });
    const b = parseEventBody({ kind: "steer", text: "left" });
    expect(a).not.toBe("string");
    expect(
      typeof a === "object" && typeof b === "object" && a.sourceEventId !== b.sourceEventId,
    ).toBe(true);
  });

  it("accepts cancel without text", () => {
    expect(parseEventBody({ kind: "cancel" })).toMatchObject({ kind: "cancel", payload: {} });
  });

  it("rejects what a client got wrong", () => {
    expect(parseEventBody({ kind: "message" })).toMatch(/text/);
    expect(parseEventBody({ kind: "message", text: "  " })).toMatch(/text/);
    expect(parseEventBody({ kind: "nope", text: "x" })).toMatch(/kind/);
    expect(parseEventBody({ kind: "delete" })).toMatch(/DELETE/);
    expect(parseEventBody({ kind: "cancel", text: "x" })).toMatch(/no text/);
    expect(parseEventBody({ kind: "message", text: "x", sourceEventId: 5 })).toMatch(
      /sourceEventId/,
    );
  });

  it("answers 400 for strings Postgres cannot store", () => {
    for (const bad of ["a\u0000b", "a\ud800b", "a\udc00b", "\ud83d"]) {
      expect(parseEventBody({ kind: "message", text: bad })).toMatch(/text must not contain/);
      expect(parseEventBody({ kind: "message", text: "ok", sourceEventId: bad })).toMatch(
        /sourceEventId must not contain/,
      );
    }
    expect(parseEventBody({ kind: "message", text: "ok \u{1F600}" })).toEqual(
      expect.objectContaining({ payload: { text: "ok \u{1F600}" } }),
    );
  });
});
