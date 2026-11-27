/**
 * The `get_transcript` logic of the MCP adapter: one page of committed transcript entries after a cursor, oldest first.
 * Built only on `SessionApi.openStream` (ADR 0071): the session API has no JSON route for the transcript, so the page is
 * read from the stream. The server replays the entries after `Last-Event-ID` and then sends its first `live` event, so
 * that event means the replay caught up and ends the read; the connection is closed as soon as the page is full.
 *
 * Everything in an entry is untrusted (the agent's text, the arguments of its tool calls, the output of its tools). Each
 * field is cut to a per-field cap, and the entries together to a response cap, so one scraped page cannot fill the
 * client's context.
 */
import { ApiError, type SessionApi } from "./api.js";
import { readSse } from "./sse.js";
import { cutUtf8 } from "./wait.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** The cap of the serialised entries of one response, as `wait` caps its text. */
export const MAX_RESPONSE_BYTES = 24_576;
/** The cap of one field (a message's text, a call's arguments) in UTF-8 bytes. */
export const MAX_FIELD_BYTES = 4096;
/** Entries read per call, filtered out or not, so a `kinds` filter that matches little still ends. */
export const MAX_SCAN = 500;
export const READ_TIMEOUT_MS = 20_000;
/** What an entry that does not fit the cap at the full field cap is tried at, one after the other, when it comes first. */
const SHRINK_STEPS = [4, 16, 64];

/** `user`: input; `assistant`: an answer; `call`: an assistant message that calls tools; `result`: a tool result. */
export const TRANSCRIPT_KINDS = ["user", "assistant", "call", "result", "error"] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export interface TranscriptCall {
  name: string;
  /** The JSON text of the arguments. Cut when `truncated`. */
  arguments: string;
  truncated?: true;
  /** UTF-8 bytes of the whole arguments, only when `truncated`. */
  length?: number;
}

export interface TranscriptMessage {
  role: string;
  text: string;
  truncated?: true;
  /** UTF-8 bytes of the whole text, only when `truncated`. */
  length?: number;
  calls?: TranscriptCall[];
  isError?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface TranscriptEntry {
  id: number;
  kind: string;
  messages: TranscriptMessage[];
  /** The entry was too large to show even cut to the smallest field cap: `length` is its size, nothing else is shown. */
  omitted?: true;
  length?: number;
}

export interface TranscriptInput {
  sessionId: string;
  /** Id of the last entry the caller has already seen (the `cursor` of an earlier result). */
  cursor?: number;
  limit: number;
  kinds?: readonly TranscriptKind[];
  signal?: AbortSignal;
}

export interface TranscriptOptions {
  maxBytes?: number;
  maxFieldBytes?: number;
  maxScan?: number;
  timeoutMs?: number;
}

export interface TranscriptResult {
  sessionId: string;
  entries: TranscriptEntry[];
  /** Id of the last entry read, returned or filtered out; pass it to the next call. Absent while nothing was read. */
  cursor?: number;
  /** More entries may follow: call again with `cursor`. False only when the read caught up with the transcript. */
  hasMore: boolean;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A string cut to `limit` bytes; the original size and a flag are added when it was cut. */
function capField(
  text: string,
  limit: number,
): { text: string; truncated?: true; length?: number } {
  const length = Buffer.byteLength(text);
  if (length <= limit) return { text };
  return { text: cutUtf8(text, limit), truncated: true, length };
}

/** `name({"a":1})`, as the orchestrator writes a call (`toEvent`), to name and arguments. */
function splitCall(call: string, limit: number): TranscriptCall {
  const open = call.indexOf("(");
  const name = open === -1 ? call : call.slice(0, open);
  const args = open === -1 ? "" : call.slice(open + 1, call.endsWith(")") ? -1 : undefined);
  const cut = capField(args, limit);
  return {
    name: name.slice(0, 200),
    arguments: cut.text,
    ...(cut.truncated === true ? { truncated: true as const, length: cut.length } : {}),
  };
}

function usageOf(value: unknown): TranscriptMessage["usage"] {
  if (!isObject(value)) return undefined;
  const num = (key: string): number =>
    typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0;
  return {
    input: num("input"),
    output: num("output"),
    cacheRead: num("cacheRead"),
    cacheWrite: num("cacheWrite"),
    cost: num("cost"),
  };
}

function toMessage(raw: unknown, limit: number): TranscriptMessage | undefined {
  if (!isObject(raw) || typeof raw.role !== "string") return undefined;
  const cut = capField(typeof raw.text === "string" ? raw.text : "", limit);
  const calls = Array.isArray(raw.calls)
    ? raw.calls.flatMap((call) => (typeof call === "string" ? [splitCall(call, limit)] : []))
    : [];
  const usage = usageOf(raw.usage);
  return {
    role: raw.role.slice(0, 32),
    text: cut.text,
    ...(cut.truncated === true ? { truncated: true as const, length: cut.length } : {}),
    ...(calls.length > 0 ? { calls } : {}),
    ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** The kinds an entry belongs to; a `kinds` filter keeps an entry that has any of them. */
function kindsOf(messages: unknown[]): Set<TranscriptKind> {
  const found = new Set<TranscriptKind>();
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role === "user") found.add("user");
    else if (message.role === "assistant") {
      found.add("assistant");
      if (Array.isArray(message.calls) && message.calls.length > 0) found.add("call");
    } else if (message.role === "toolResult") {
      found.add("result");
      if (message.isError === true) found.add("error");
    }
  }
  return found;
}

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export async function readTranscript(
  api: SessionApi,
  input: TranscriptInput,
  opts: TranscriptOptions = {},
): Promise<TranscriptResult> {
  const { sessionId } = input;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const fieldBytes = opts.maxFieldBytes ?? MAX_FIELD_BYTES;
  const maxScan = opts.maxScan ?? MAX_SCAN;
  const wanted = input.kinds === undefined ? undefined : new Set(input.kinds);

  const conn = new AbortController();
  const timer = setTimeout(() => {
    conn.abort();
  }, opts.timeoutMs ?? READ_TIMEOUT_MS);
  const onAbort = (): void => {
    conn.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const entries: TranscriptEntry[] = [];
  let bytes = 2;
  let lastId = input.cursor;
  let scanned = 0;
  let caughtUp = false;
  let hasMore = false;
  let full = false;

  /** The entry at the full field cap; the first one of a page is shrunk until it fits, a later one waits for the next. */
  const render = (id: number, kind: string, messages: unknown[]): TranscriptEntry | undefined => {
    const build = (limit: number): TranscriptEntry => ({
      id,
      kind: kind.slice(0, 64),
      messages: messages.flatMap((m) => {
        const message = toMessage(m, limit);
        return message === undefined ? [] : [message];
      }),
    });
    const room = maxBytes - bytes - (entries.length > 0 ? 1 : 0);
    let entry = build(fieldBytes);
    if (sizeOf(entry) <= room) return entry;
    if (entries.length > 0) return undefined;
    for (const divisor of SHRINK_STEPS) {
      entry = build(Math.max(1, Math.floor(fieldBytes / divisor)));
      if (sizeOf(entry) <= room) return entry;
    }
    const stub: TranscriptEntry = {
      id,
      kind: kind.slice(0, 64),
      messages: [],
      omitted: true,
      length: sizeOf(messages),
    };
    return stub;
  };

  try {
    input.signal?.throwIfAborted();
    let res: Response;
    try {
      res = await api.openStream(sessionId, input.cursor, conn.signal);
    } catch (error) {
      if (input.signal?.aborted !== true && conn.signal.aborted) {
        throw new ApiError(0, "timed out opening the transcript stream");
      }
      throw error;
    }
    if (res.status !== 200 || res.body === null) throw await api.errorFromResponse(res);

    for await (const event of readSse(res.body, conn.signal)) {
      if (event.event === "deleted") throw new ApiError(410, "session deleted");
      if (event.event === "live") {
        caughtUp = true;
        break;
      }
      if (event.event !== "entry") continue;
      const data = parseJson(event.data);
      if (!isObject(data) || typeof data.id !== "number" || !Array.isArray(data.messages)) continue;
      // Entries are sent once, in order; an id at or before the cursor would be a replay, never a new entry.
      if (lastId !== undefined && data.id <= lastId) continue;
      if (full) {
        hasMore = true;
        break;
      }
      const matches =
        wanted === undefined || [...kindsOf(data.messages)].some((k) => wanted.has(k));
      if (matches) {
        const entry = render(
          data.id,
          typeof data.kind === "string" ? data.kind : "",
          data.messages,
        );
        if (entry === undefined) {
          hasMore = true;
          break;
        }
        bytes += sizeOf(entry) + (entries.length > 0 ? 1 : 0);
        entries.push(entry);
        if (entries.length >= input.limit) full = true;
      }
      lastId = data.id;
      scanned++;
      if (scanned >= maxScan) full = true;
    }
    input.signal?.throwIfAborted();
    // Neither caught up nor stopped on purpose: the stream ended or the read timed out. The caller continues.
    if (!caughtUp && !hasMore) {
      if (!full && lastId === input.cursor) {
        throw new ApiError(0, "the transcript stream ended before it caught up; retry");
      }
      hasMore = true;
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    conn.abort();
  }

  return { sessionId, entries, ...(lastId === undefined ? {} : { cursor: lastId }), hasMore };
}
