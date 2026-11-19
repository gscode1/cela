/** One server-sent event as the wire format gives it. */
export interface SseMessage {
  event: string;
  data: string;
  /** The `id:` field; undefined when the block has none (a `live` event). */
  id: string | undefined;
}

/**
 * An incremental parser of the `text/event-stream` format. The console reads the stream with `fetch` because an
 * `EventSource` cannot send the `Authorization` header, so the framing is ours: chunks may split a line or a block
 * anywhere, and the three line endings (`\n`, `\r\n`, `\r`) all occur.
 */
export class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  #id: string | undefined;

  /** Feeds text; returns the events completed by it, in order. Comments (`: keepalive`) and `retry:` are dropped. */
  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const end = /\r\n|\n|\r/.exec(this.#buffer);
      if (end === null) break;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (end[0] === "\r" && end.index + 1 === this.#buffer.length) break;
      const line = this.#buffer.slice(0, end.index);
      this.#buffer = this.#buffer.slice(end.index + end[0].length);
      if (line === "") {
        const message = this.#dispatch();
        if (message !== undefined) out.push(message);
      } else this.#field(line);
    }
    return out;
  }

  #field(line: string): void {
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") this.#event = value;
    else if (name === "data") this.#data.push(value);
    else if (name === "id") this.#id = value;
  }

  #dispatch(): SseMessage | undefined {
    const had = this.#data.length > 0;
    const message: SseMessage = {
      event: this.#event === "" ? "message" : this.#event,
      data: this.#data.join("\n"),
      id: this.#id,
    };
    this.#event = "";
    this.#data = [];
    this.#id = undefined;
    return had ? message : undefined;
  }
}
