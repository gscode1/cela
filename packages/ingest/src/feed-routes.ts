import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import {
  errorMessage,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  parseCursor,
  readFeed,
  sendJson,
} from "@cela/session-core";
import type { FeedPage } from "@cela/session-core";
import { log } from "./log.js";

/** Open feed streams per ingest replica: each polls the table about every second (ADR 0058). */
export const MAX_FEED_STREAMS = 100;
const STREAM_POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;

export interface FeedStreamOptions {
  pollMs?: number;
  heartbeatMs?: number;
}

let openStreams = 0;

/** The open feed streams of this process; for tests. */
export function feedStreamCount(): number {
  return openStreams;
}

/** `GET /events?cursor=&limit=`: one page of the caller's feed. */
export async function getFeed(
  res: ServerResponse,
  pool: pg.Pool,
  subject: string,
  url: URL,
): Promise<void> {
  const cursor = cursorParam(url.searchParams.get("cursor"));
  if (cursor === "invalid") {
    sendJson(res, 400, { error: "cursor must be a cursor this API returned, or latest" });
    return;
  }
  const limit = limitParam(url.searchParams.get("limit"));
  if (limit === undefined) {
    sendJson(res, 400, { error: `limit must be an integer from 1 to ${String(FEED_LIMIT_MAX)}` });
    return;
  }
  sendJson(res, 200, await readFeed(pool, subject, cursor, limit));
}

/**
 * `GET /events/stream`: the same rows as server-sent events, each with its cursor as the SSE id, resumed from
 * `Last-Event-ID`. A `heartbeat` event (a data frame, as MCP Events push expects) carries the cursor every 15 s.
 */
export function streamFeed(
  req: IncomingMessage,
  res: ServerResponse,
  pool: pg.Pool,
  subject: string,
  options: FeedStreamOptions = {},
): void {
  const header = req.headers["last-event-id"];
  const resumed = cursorParam(typeof header === "string" ? header : null);
  if (resumed === "invalid") {
    sendJson(res, 400, { error: "Last-Event-ID must be a cursor this API returned, or latest" });
    return;
  }
  if (openStreams >= MAX_FEED_STREAMS) {
    sendJson(res, 503, { error: "too many feed streams, retry" }, { "retry-after": "5" });
    return;
  }
  openStreams += 1;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  let cursor: Parameters<typeof readFeed>[2] = resumed;
  let closed = false;
  // A call, not a read: `close` can fire at any await, which flow narrowing cannot see.
  const isClosed = (): boolean => closed;
  let lastWrite = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const send = (event: string, id: string | undefined, data: unknown): void => {
    res.write(
      `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
    lastWrite = Date.now();
  };
  const tick = async (): Promise<void> => {
    try {
      let page: FeedPage;
      do {
        page = await readFeed(pool, subject, cursor);
        if (isClosed()) return;
        if (page.truncated) send("truncated", undefined, { cursor: page.cursor });
        for (const event of page.events) send(event.type, event.cursor, event);
        cursor = parseCursor(page.cursor);
      } while (page.hasMore && !isClosed());
      if (Date.now() - lastWrite >= heartbeatMs)
        send("heartbeat", page.cursor, { cursor: page.cursor });
    } catch (error) {
      // The database is away: end the stream, the client reconnects with its last id.
      log("feed-stream-failed", { message: errorMessage(error) });
      res.end();
      return;
    }
    if (!isClosed()) timer = setTimeout(() => void tick(), options.pollMs ?? STREAM_POLL_MS);
  };
  res.on("close", () => {
    closed = true;
    openStreams -= 1;
    if (timer !== undefined) clearTimeout(timer);
  });
  void tick();
}

function cursorParam(raw: string | null): ReturnType<typeof parseCursor> | "invalid" {
  if (raw === null || raw === "") return undefined;
  return parseCursor(raw) ?? "invalid";
}

function limitParam(raw: string | null): number | undefined {
  if (raw === null) return FEED_LIMIT_DEFAULT;
  if (!/^[0-9]{1,3}$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit >= 1 && limit <= FEED_LIMIT_MAX ? limit : undefined;
}
