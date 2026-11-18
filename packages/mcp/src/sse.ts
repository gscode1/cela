/** One dispatched server-sent event. `id` is set only when this event's own block carried an `id:` line. */
export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/**
 * Incremental parser for the WHATWG server-sent events format. Chunks may be split anywhere, including mid-line and
 * between a CR and its LF. A block without `data:` lines dispatches nothing (so a bare `id:` is dropped), and an
 * unterminated block at the end of input is discarded, as the spec says.
 *
 * Unlike a browser's EventSource, the id is not sticky: a `live` event the server sends without an id must not
 * inherit the previous entry's id, because the id is the resume cursor.
 */
export class SseParser {
  private buffer = "";
  private started = false;
  private skipLf = false;
  private id: string | undefined;
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.skipLf && text.length > 0) {
      if (text.startsWith("\n")) text = text.slice(1);
      this.skipLf = false;
    }
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.startsWith("﻿")) text = text.slice(1);
    }
    this.buffer += text;

    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      const dispatched = this.line(this.buffer.slice(start, i));
      if (dispatched !== undefined) events.push(dispatched);
      if (c === "\r") {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === "\n") i++;
        } else {
          this.skipLf = true;
        }
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const { id, event, data } = this;
    this.id = undefined;
    this.event = "";
    this.data = [];
    if (data.length === 0) return undefined;
    const result: SseEvent = { event: event === "" ? "message" : event, data: data.join("\n") };
    if (id !== undefined) result.id = id;
    return result;
  }
}

/**
 * Yields the events of an SSE response body. Ends when the stream ends or `signal` aborts; either way the body is
 * cancelled and the reader released. A stream error that is not an abort is rethrown.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parser = new SseParser();
  // A function, so the compiler does not narrow `signal.aborted` to its value at the loop head.
  const aborted = (): boolean => signal?.aborted === true;
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  if (aborted()) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!aborted()) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (aborted()) return;
        throw error;
      }
      if (result.done) {
        // Flush a multibyte sequence cut off at the end; an unterminated block is dropped by design.
        yield* parser.push(decoder.decode());
        return;
      }
      for (const event of parser.push(decoder.decode(result.value, { stream: true }))) {
        if (aborted()) return;
        yield event;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
