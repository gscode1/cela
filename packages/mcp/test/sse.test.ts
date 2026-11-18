import { describe, expect, it } from "vitest";
import { readSse, SseParser, type SseEvent } from "../src/sse.js";

const TIMEOUT = 5000;

function parseChunks(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const SAMPLE =
  ": keepalive\n\n" +
  'id: 7\nevent: entry\ndata: {"id":7}\n\n' +
  'event: live\ndata: {"running":true}\n\n' +
  "event: deleted\ndata: {}\n\n";

const SAMPLE_EVENTS: SseEvent[] = [
  { id: "7", event: "entry", data: '{"id":7}' },
  { event: "live", data: '{"running":true}' },
  { event: "deleted", data: "{}" },
];

describe("SseParser", () => {
  it("parses a sample split at every position", { timeout: TIMEOUT }, () => {
    for (const text of [SAMPLE, SAMPLE.replaceAll("\n", "\r\n"), SAMPLE.replaceAll("\n", "\r")]) {
      for (let i = 0; i <= text.length; i++) {
        expect(parseChunks([text.slice(0, i), text.slice(i)])).toEqual(SAMPLE_EVENTS);
      }
      expect(parseChunks(text.split(/(?:)/u))).toEqual(SAMPLE_EVENTS);
    }
  });

  it("joins multiple data lines with a newline", { timeout: TIMEOUT }, () => {
    expect(parseChunks(["data: a\ndata:\ndata: b\n\n"])).toEqual([
      { event: "message", data: "a\n\nb" },
    ]);
  });

  it(
    "strips only one leading space and handles a field without colon",
    { timeout: TIMEOUT },
    () => {
      expect(parseChunks(["data:  x\ndata\n\n"])).toEqual([{ event: "message", data: " x\n" }]);
    },
  );

  it("ignores comments and unknown fields", { timeout: TIMEOUT }, () => {
    expect(parseChunks([": hi\nretry: 5\nfoo: bar\n: more\ndata: x\n\n"])).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  it("dispatches nothing for an id without data and does not leak it", { timeout: TIMEOUT }, () => {
    expect(parseChunks(["id: 3\n\n", "data: y\n\n"])).toEqual([{ event: "message", data: "y" }]);
  });

  it("does not carry an id to a later event", { timeout: TIMEOUT }, () => {
    const events = parseChunks(["id: 1\ndata: a\n\ndata: b\n\n"]);
    expect(events[0]?.id).toBe("1");
    expect(events[1]).toEqual({ event: "message", data: "b" });
  });

  it("drops an unterminated trailing block", { timeout: TIMEOUT }, () => {
    expect(parseChunks(["data: a\n\ndata: b\n"])).toEqual([{ event: "message", data: "a" }]);
  });

  it("strips a BOM at the start only", { timeout: TIMEOUT }, () => {
    expect(parseChunks(["﻿", "data: a\n\n"])).toEqual([{ event: "message", data: "a" }]);
    expect(parseChunks(["data: ﻿a\n\n"])).toEqual([{ event: "message", data: "﻿a" }]);
  });

  it("treats a lone CR then LF across chunks as one terminator", { timeout: TIMEOUT }, () => {
    expect(parseChunks(["data: a\r", "\ndata: b\r\n\r", "\n"])).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });
});

describe("readSse", () => {
  it("decodes multibyte UTF-8 split across chunks", { timeout: TIMEOUT }, async () => {
    const bytes = new TextEncoder().encode("data: héllo €𝄞\n\n");
    for (let i = 1; i < bytes.length; i++) {
      const events = await collect(readSse(streamOf([bytes.slice(0, i), bytes.slice(i)])));
      expect(events).toEqual([{ event: "message", data: "héllo €𝄞" }]);
    }
    const bytewise = [...bytes].map((b) => Uint8Array.of(b));
    expect(await collect(readSse(streamOf(bytewise)))).toEqual([
      { event: "message", data: "héllo €𝄞" },
    ]);
  });

  it("ends cleanly when the stream ends", { timeout: TIMEOUT }, async () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    expect(await collect(readSse(streamOf([bytes])))).toEqual(SAMPLE_EVENTS);
  });

  it(
    "ends when the signal aborts while waiting and cancels the body",
    { timeout: TIMEOUT },
    async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: a\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      });
      const ac = new AbortController();
      const seen: SseEvent[] = [];
      for await (const event of readSse(body, ac.signal)) {
        seen.push(event);
        setTimeout(() => ac.abort(), 10);
      }
      expect(seen).toEqual([{ event: "message", data: "a" }]);
      expect(cancelled).toBe(true);
    },
  );

  it("yields nothing when already aborted", { timeout: TIMEOUT }, async () => {
    const ac = new AbortController();
    ac.abort();
    expect(
      await collect(readSse(streamOf([new TextEncoder().encode("data: a\n\n")]), ac.signal)),
    ).toEqual([]);
  });

  it("rethrows a stream error that is not an abort", { timeout: TIMEOUT }, async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    await expect(collect(readSse(body))).rejects.toThrow("boom");
  });
});
