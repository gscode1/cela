/**
 * The `wait` logic of the MCP adapter: block until the agent is done with the queued messages, or until the deadline,
 * and return the new assistant text. Built only on `SessionApi`; the tool layer owns the timeout clamp and error mapping.
 *
 * Why "done" is derived the way it is: a `live` idle event alone is not proof the agent finished. A message that was
 * just posted sits in `events.pending` before the orchestrator picks it up, and the session looks idle in that gap.
 * So idle counts only when it comes from a stream connection opened AFTER a GET that showed `pending == 0`: such a
 * connection starts with the orchestrator's current state, which cannot predate the message.
 */
import { ApiError, type SessionApi, type SessionStatus, type SessionSummary } from "./api.js";
import { readSse } from "./sse.js";

export const DEFAULT_TIMEOUT_SEC = 45;
export const MAX_TIMEOUT_SEC = 50;
export const MAX_TEXT_BYTES = 24_576;
const TRUNCATION_MARKER = "\n[… truncated]";
const SEPARATOR = "\n\n";

export function clampTimeoutSec(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(1, value));
}

export interface WaitInput {
  sessionId: string;
  /** Id of the last entry the caller has already seen (the `cursor` of an earlier result). */
  cursor?: number;
  /** Epoch ms. */
  deadline: number;
}

export interface WaitOptions {
  now?: () => number;
  /** How often the session is re-read. Default 1000. */
  pollMs?: number;
  /** How long idle must hold, with no new entry or live event, before done. Default 500. */
  idleMs?: number;
  /** Cap of the returned text in UTF-8 bytes. Default 24576. */
  maxBytes?: number;
}

export interface WaitResult {
  sessionId: string;
  done: boolean;
  status: SessionStatus;
  /** Id of the last entry returned whole (or skipped); pass it to the next `wait`. Absent while nothing was seen. */
  cursor?: number;
  /** Assistant text, untrusted. */
  text: string;
  /** Text was cut at the byte cap: either more entries wait for the next call, or one oversize entry was cut. */
  truncated: boolean;
  /** Untrusted. */
  runFailure?: string;
  /** Untrusted. */
  failure?: string;
  events: SessionSummary["events"];
}

type Stop = "truncated" | "deleted" | "gone" | "unavailable" | "closed";

interface Connection {
  abort: AbortController;
  /** Opened after a GET that showed pending == 0: its idle events count. */
  trusted: boolean;
}

interface EntryData {
  id: number;
  messages: { role?: unknown; text?: unknown }[];
}

interface LiveData {
  running?: unknown;
  queued?: unknown;
  runFailure?: unknown;
}

const isTerminal = (status: SessionStatus): boolean => status !== "active";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The longest prefix of `text` that fits `maxBytes` of UTF-8 without splitting a character. */
function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export async function waitForSession(
  api: SessionApi,
  input: WaitInput,
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const { sessionId, deadline } = input;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 1000;
  const idleMs = opts.idleMs ?? 500;
  const maxBytes = opts.maxBytes ?? MAX_TEXT_BYTES;

  let lastId = input.cursor;
  const parts: string[] = [];
  let bytes = 0;
  let truncated = false;
  let runFailure: string | undefined;
  let summary: SessionSummary;
  // Set by the stream task; a holder, so the compiler does not narrow them to their initial value in the loop.
  const flags: {
    stop?: Stop;
    fatal?: ApiError;
    conn: Connection | undefined;
    idle: boolean;
    idleSince: number;
    /** Bumped by every entry and live event, so the final check can tell that something arrived meanwhile. */
    activity: number;
  } = { conn: undefined, idle: false, idleSince: 0, activity: 0 };

  // A wake-up flag next to the resolver, so a wake between the loop checks and the sleep is not lost.
  let wake: (() => void) | undefined;
  let woken = false;
  const signal = (): void => {
    woken = true;
    wake?.();
  };
  const sleep = (ms: number): Promise<void> => {
    if (woken || ms <= 0) {
      woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wake = undefined;
        woken = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });
  };

  const result = (done: boolean): WaitResult => ({
    sessionId,
    done,
    status: summary.status,
    ...(lastId === undefined ? {} : { cursor: lastId }),
    text: parts.join(SEPARATOR),
    truncated,
    ...(runFailure === undefined ? {} : { runFailure }),
    ...(summary.failure === undefined ? {} : { failure: summary.failure }),
    events: summary.events,
  });

  /** One entry of the stream. Stops before an entry that would not fit; cuts one that cannot fit even alone. */
  const onEntry = (data: EntryData): void => {
    if (typeof data.id !== "number" || (lastId !== undefined && data.id <= lastId)) return;
    const texts = data.messages
      .filter((m) => m.role === "assistant" && typeof m.text === "string" && m.text !== "")
      .map((m) => String(m.text));
    const entryText = texts.join(SEPARATOR);
    if (entryText !== "") {
      const size = (parts.length > 0 ? SEPARATOR.length : 0) + Buffer.byteLength(entryText);
      if (bytes + size > maxBytes) {
        truncated = true;
        if (parts.length > 0) {
          // The caller takes what we have and calls again; the entry comes first next time.
          flags.stop = "truncated";
          return;
        }
        parts.push(cutUtf8(entryText, maxBytes) + TRUNCATION_MARKER);
        bytes = maxBytes;
      } else {
        parts.push(entryText);
        bytes += size;
      }
    }
    lastId = data.id;
  };

  const onLive = (live: LiveData): void => {
    if (live.running === true || (typeof live.queued === "number" && live.queued > 0)) {
      flags.idle = false;
      runFailure = undefined;
    } else if (flags.conn?.trusted === true) {
      flags.idle = true;
      if (typeof live.runFailure === "string") runFailure = live.runFailure;
    }
  };

  const pump = async (c: Connection): Promise<void> => {
    const aborted = (): boolean => c.abort.signal.aborted;
    try {
      const res = await api.openStream(sessionId, lastId, c.abort.signal);
      if (aborted()) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      if (res.status !== 200 || res.body === null) {
        const error = await api.errorFromResponse(res);
        if (res.status === 410) flags.stop = "gone";
        else if (res.status === 401 || res.status === 404) flags.fatal = error;
        else flags.stop = "unavailable";
        return;
      }
      for await (const event of readSse(res.body, c.abort.signal)) {
        if (aborted() || flags.stop !== undefined) return;
        if (event.event === "deleted") {
          flags.stop = "deleted";
          return;
        }
        const data = parseJson(event.data);
        if (typeof data !== "object" || data === null) continue;
        if (event.event === "entry") onEntry(data as EntryData);
        else if (event.event === "live") onLive(data);
        else continue;
        flags.activity++;
        flags.idleSince = now();
      }
      if (!aborted()) flags.stop ??= "closed";
    } catch {
      // Network error or a stream that broke: the caller gets what we have and calls again.
      if (!aborted()) flags.stop ??= "closed";
    } finally {
      signal();
    }
  };

  const get = (): Promise<SessionSummary> =>
    api.getSession(sessionId, AbortSignal.timeout(Math.max(1000, deadline - now())));

  // A function, so the compiler does not keep `flags.idle` narrowed across the await of a refresh.
  const isIdle = (): boolean => flags.idle;

  const dropConnection = (): void => {
    flags.conn?.abort.abort();
    flags.conn = undefined;
  };

  /** Takes a fresh GET. A pending message makes the connection untrusted; a clean GET replaces an untrusted one. */
  const apply = (next: SessionSummary): void => {
    summary = next;
    if (next.events.pending > 0) {
      if (flags.conn !== undefined) flags.conn.trusted = false;
      flags.idle = false;
    } else if (flags.conn?.trusted === false) {
      dropConnection();
      flags.idle = false;
    }
  };

  /** A GET that failed mid-wait only ends the wait, unless the API says the token or session is wrong. */
  const refresh = async (): Promise<boolean> => {
    try {
      apply(await get());
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401 && error.status !== 404) return false;
      throw error;
    }
  };

  try {
    summary = await get();
    apply(summary);
    let nextPoll = now() + pollMs;

    for (;;) {
      if (flags.fatal !== undefined) throw flags.fatal;
      if (isTerminal(summary.status)) return result(true);
      const { stop } = flags;
      if (stop === "truncated" || stop === "unavailable" || stop === "closed") return result(false);
      if (stop === "deleted" || stop === "gone") {
        try {
          summary = await get();
        } catch (error) {
          // Deleted sessions may answer 410 to the GET; the stream already told us.
          if (!(error instanceof ApiError) || error.status !== 410) throw error;
          summary = { ...summary, status: "deleted" };
        }
        return result(true);
      }
      const t = now();
      if (t >= deadline) return result(false);

      if (t >= nextPoll) {
        if (!(await refresh())) return result(false);
        nextPoll = now() + pollMs;
        continue;
      }
      if (flags.idle && t - flags.idleSince >= idleMs) {
        // Confirm with the API, and that nothing arrived while we asked.
        const seen = flags.activity;
        if (!(await refresh())) return result(false);
        if (isIdle() && flags.activity === seen && summary.events.pending === 0)
          return result(true);
        continue;
      }
      if (flags.conn === undefined) {
        const c: Connection = {
          abort: new AbortController(),
          trusted: summary.events.pending === 0,
        };
        flags.conn = c;
        void pump(c);
      }
      const idleAt = flags.idle ? flags.idleSince + idleMs : Infinity;
      await sleep(Math.min(deadline, nextPoll, idleAt) - t);
    }
  } finally {
    dropConnection();
  }
}
