import { describe, expect, it } from "vitest";
import { formatCursor, parseCursor } from "../src/feed.ts";

describe("feed cursors", () => {
  it("round-trips a position", () => {
    expect(parseCursor(formatCursor({ xid: "868", id: "12" }))).toEqual({ xid: "868", id: "12" });
    expect(parseCursor("latest")).toBe("latest");
  });

  it("refuses anything Postgres would answer with an error", () => {
    for (const raw of [
      "",
      "1",
      "1-",
      "-1",
      "a-1",
      "1-1-1",
      "18446744073709551616-1",
      "1-9223372036854775808",
    ]) {
      expect(parseCursor(raw), raw).toBeUndefined();
    }
  });
});
