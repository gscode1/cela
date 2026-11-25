import { describe, expect, it } from "vitest";
import { formatSessionCursor, parseSessionCursor } from "../src/session-list.ts";

describe("session list cursors", () => {
  const position = {
    createdAt: "2026-11-25T10:00:00.123456",
    id: "11111111-2222-4333-8444-555555555555",
  };

  it("round-trips a position", () => {
    expect(parseSessionCursor(formatSessionCursor(position))).toEqual(position);
  });

  it("refuses anything this module did not issue", () => {
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    for (const raw of [
      "",
      "abc",
      "a b",
      "x".repeat(101),
      encode("2026-11-25T10:00:00.123_11111111-2222-4333-8444-555555555555"),
      encode(`${position.createdAt}_not-a-uuid`),
      encode(`${position.createdAt}_${position.id}_extra`),
      encode(position.createdAt),
    ]) {
      expect(parseSessionCursor(raw), raw).toBeUndefined();
    }
  });
});
