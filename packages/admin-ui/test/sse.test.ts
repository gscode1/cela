import { describe, expect, it } from "vitest";
import { SseParser } from "@/lib/sse";

describe("SseParser", () => {
  it("reads blocks with event, id and data", () => {
    const parser = new SseParser();
    expect(parser.push('id: 7\nevent: entry\ndata: {"a":1}\n\n')).toEqual([
      { event: "entry", data: '{"a":1}', id: "7" },
    ]);
  });

  it("joins a block that arrives in pieces, split anywhere", () => {
    const parser = new SseParser();
    const text = 'id: 3\nevent: entry\ndata: {"x":"y"}\n\nevent: live\ndata: {}\n\n';
    const out = Array.from(text, (char) => parser.push(char)).flat();
    expect(out).toEqual([
      { event: "entry", data: '{"x":"y"}', id: "3" },
      { event: "live", data: "{}", id: undefined },
    ]);
  });

  it("accepts CRLF and lone CR line ends, even when a CRLF is split", () => {
    const parser = new SseParser();
    expect(parser.push("event: live\r\ndata: 1\r\n\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "live", data: "1", id: undefined }]);
    // A final lone CR might begin a CRLF, so the block closes when the next byte shows it did not.
    expect(parser.push("data: 2\r\r")).toEqual([]);
    expect(parser.push("data: 3\n\n")).toEqual([
      { event: "message", data: "2", id: undefined },
      { event: "message", data: "3", id: undefined },
    ]);
  });

  it("drops comments, retry and blocks without data, and does not carry an id over", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\nretry: 2000\n\n")).toEqual([]);
    expect(parser.push("id: 5\ndata: a\n\n")).toHaveLength(1);
    expect(parser.push("data: b\n\n")).toEqual([{ event: "message", data: "b", id: undefined }]);
  });

  it("joins several data lines with a newline", () => {
    expect(new SseParser().push("data: a\ndata: b\n\n")[0]?.data).toBe("a\nb");
  });
});
