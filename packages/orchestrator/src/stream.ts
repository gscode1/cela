import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationView, ConversationWatch, EntryRecord } from "@earendil-works/pi-durable";
import { errorMessage } from "@pi-durable-k8s/session-core";
import type { Host } from "./host.js";
import { toEvent } from "./host.js";
import { log } from "./log.js";
import type { StreamRegistry } from "./sessions.js";

const KEEPALIVE_MS = 15_000;
const GAP_PAGE = 100;

/** What the client sees of the run in progress. Carries no SSE id: it is not addressable by a cursor. */
export interface LiveEvent {
  running: boolean;
  /** Inputs queued behind the running turn. */
  queued: number;
  /** The throttled partial answer of the response being generated, if any. */
  partial?: string;
  tools?: { callId: string; name: string; status: string }[];
  /** Why the newest run ended without an answer, e.g. `aborted`. */
  runFailure?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Projects `pi.live` and `pi.inbox` of a conversation view. Defensive: these are plain JSON documents. */
export function liveEvent(docs: ConversationView["docs"]): LiveEvent {
  const live = asObject(docs["pi.live"]);
  const inbox = asObject(docs["pi.inbox"]);
  const items = inbox?.items;
  const event: LiveEvent = {
    running: live?.run !== undefined,
    queued: Array.isArray(items) ? items.length : 0,
  };
  const content = asObject(asObject(live?.generation)?.message)?.content;
  if (Array.isArray(content)) {
    const partial = content
      .map((block) => {
        const b = asObject(block);
        return b?.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .join("");
    if (partial !== "") event.partial = partial;
  }
  if (Array.isArray(live?.tools)) {
    event.tools = (live.tools as unknown[]).flatMap((slot) => {
      const s = asObject(slot);
      return s !== undefined
        ? [{ callId: String(s.callId), name: String(s.name), status: String(s.status) }]
        : [];
    });
  }
  const failure = asObject(live?.runFailure);
  if (typeof failure?.reason === "string") event.runFailure = failure.reason;
  return event;
}

/** Only entries that carry model messages are streamed (inputs, answers, tool calls and results). */
function entryEvent(
  entry: EntryRecord,
): { id: number; kind: string; messages: unknown[] } | undefined {
  // System messages (the rendered system prompt) are the host's, not the conversation's: never streamed.
  const messages = (entry.model ?? []).filter((message) => message.role !== "system");
  if (messages.length === 0) return undefined;
  return { id: entry.id, kind: entry.kind, messages: messages.map(toEvent) };
}

export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = Number(raw);
  return raw !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Writes a chunk and waits for the socket to drain, or for the client to go away. Whichever event loses the race must
 * drop its listener: a slow client under backpressure would otherwise pile up one `close` listener per write.
 */
export async function write(res: ServerResponse, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  if (!res.write(chunk)) {
    const done = new AbortController();
    try {
      await Promise.race([
        once(res, "drain", { signal: done.signal }),
        once(res, "close", { signal: done.signal }),
      ]);
    } catch {
      // the stream failed or was aborted; the caller sees the closed response on its next write
    } finally {
      done.abort();
    }
  }
}

/**
 * Server-sent events for one conversation, built on `Conversation.watch()` (the conversation view).
 *
 *  - `event: entry`, `id: <entry id>`: a committed transcript entry, once, in order. The id is the cursor.
 *  - `event: live`, no id: the run in progress (partial answer, tool calls, queue). Sent whole on connect and
 *    on every change; not replayed from a cursor, so a reconnect starts from the current state of the response.
 *  - `event: deleted`: the session was deleted; the stream ends.
 *
 * A client reconnects with `Last-Event-ID: <last entry id>`: entries after it are sent first (those the
 * watch's window no longer holds are read with `Conversation.entries()`), then live updates. Without the
 * header the whole transcript is replayed from the start.
 */
export async function serveStream(
  req: IncomingMessage,
  res: ServerResponse,
  host: Host,
  streams: StreamRegistry,
  sessionId: string,
  conversationId: number,
  /** Re-checked once the stream is registered: a deletion that ran before registration closed nothing. */
  stillOpen: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<void> {
  // One object: the closures below change these, which control-flow analysis cannot see on separate `let`s.
  const state: {
    watch: ConversationWatch | undefined;
    keepalive: NodeJS.Timeout | undefined;
    ended: boolean;
  } = { watch: undefined, keepalive: undefined, ended: false };
  const finish = (reason?: string): void => {
    if (state.ended) return;
    state.ended = true;
    if (state.keepalive !== undefined) clearInterval(state.keepalive);
    unregister();
    void state.watch?.stop();
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      // Closed before the SSE head went out (deletion or disconnect while the watch was being created).
      if (reason === "deleted") {
        res.writeHead(410, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session deleted" }));
      } else {
        res.end();
      }
      return;
    }
    if (reason !== undefined) res.write(`event: ${reason}\ndata: {}\n\n`);
    res.end();
  };
  // Register and listen for the disconnect before the first await: a `close` that fires while the watch is being
  // created would never be seen by a later listener, and a deletion that ran in that window would miss the stream.
  const unregister = streams.add(sessionId, finish);
  res.on("close", () => finish());

  const watched = await host.watch(conversationId);
  if (watched === undefined) {
    if (!state.ended) {
      state.ended = true;
      unregister();
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "conversation not found" }));
    }
    return;
  }
  const { conversation } = watched;
  const watch = watched.watch;
  state.watch = watch;
  if (state.ended) {
    // The client left or the session was deleted while the watch was being created.
    void watch.stop();
    return;
  }
  // Deletion marks the session before it closes streams, so a stream registered after that close sees the mark here.
  if (!(await stillOpen())) {
    finish("deleted");
    return;
  }
  let cursor = parseLastEventId(req.headers["last-event-id"]);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  let lastLive = "";
  state.keepalive = setInterval(() => {
    if (!res.destroyed) res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);

  const sendEntry = async (entry: EntryRecord): Promise<void> => {
    if (entry.id <= cursor) return;
    cursor = entry.id;
    const event = entryEvent(entry);
    if (event !== undefined) {
      await write(res, `id: ${String(event.id)}\nevent: entry\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };

  const emit = async (view: ConversationView): Promise<void> => {
    // The window may start after the client's cursor (long outage, or a fresh connect): read the gap.
    if (view.before !== undefined && view.before > cursor) {
      let after = cursor;
      for (;;) {
        const page = await conversation.entries(
          {
            minEntryId: (after + 1) as EntryRecord["id"],
            maxEntryId: view.before,
            order: "ascending",
          },
          GAP_PAGE,
          undefined,
          context,
        );
        for (const entry of page.items) await sendEntry(entry);
        const newest = page.items.at(-1);
        if (newest === undefined || page.items.length < GAP_PAGE) break;
        after = newest.id;
      }
    }
    for (const entry of view.entries) await sendEntry(entry);
    const live = JSON.stringify(liveEvent(view.docs));
    if (live !== lastLive) {
      lastLive = live;
      await write(res, `event: live\ndata: ${live}\n\n`);
    }
  };

  try {
    await emit(watch.value);
  } catch (error) {
    log("stream-failed", { session: sessionId, message: errorMessage(error) });
    finish();
    return;
  }
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    await emit(call.value);
  });
  // The watch ends when the Harness closes (orchestrator shutdown) or fails: end the response so the client reconnects.
  void watch.closed.then(() => {
    finish();
  });
}
