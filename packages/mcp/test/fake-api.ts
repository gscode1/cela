/**
 * A fake session API for tests: a real node:http server on an ephemeral port (`listen(0)`), so the code under test
 * goes through real `fetch` and real SSE framing. Shapes follow docs/session-api.md, packages/ingest/src/server.ts
 * and the SSE of packages/orchestrator/src/stream.ts.
 *
 *   const api = await FakeApi.start();            // api.url, api.token
 *   const s = api.addSession({ events: { pending: 1 } });
 *   api.pushEntry(s.id, assistant("hi"));         // committed entry: `id:` + `event: entry`
 *   api.pushLive(s.id, { running: false, queued: 0 });
 *   await api.close();                            // in afterEach
 *
 * What it does:
 *  - Auth: every request needs `Authorization: Bearer <api.token>`, else 401.
 *  - `POST /sessions` creates a session (201). `GET /sessions/{id}` returns the scripted summary. Unknown id: 404.
 *  - `POST /sessions/{id}/events`: `message` and `cancel`. A `message` raises `events.pending` by one. A failed or
 *    deleting session answers 409, a deleted one 410. `sourceEventId` dedups: the same id for the same session is
 *    `202 {duplicate: true}` with the first eventId, for another session 409.
 *  - `DELETE /sessions/{id}`: 202, the session becomes `deleted`, open streams get `event: deleted` and end.
 *  - `GET /sessions/{id}/stream`: SSE. Replays entries after `Last-Event-ID`, then the last live event, then whatever
 *    the test pushes. `failNextStream` makes the next connections answer an error (503 + Retry-After, 410, ...).
 *  - Every request is recorded in `api.requests`.
 *  - `api.redirectTo = "<url>"` answers every request with a 307 to that URL.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type SessionStatus = "active" | "failed" | "deleting" | "deleted";

export interface EntryMessage {
  role: "user" | "assistant" | "toolResult";
  text: string;
  calls?: string[];
  isError?: boolean;
}

/** The `live` event data (orchestrator `LiveEvent`). */
export interface LiveData {
  running: boolean;
  queued: number;
  partial?: string;
  tools?: { callId: string; name: string; status: string }[];
  runFailure?: string;
}

export interface RecordedRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON when the body is JSON, the raw text otherwise, undefined when empty. */
  body: unknown;
}

export interface FakeSession {
  id: string;
  status: SessionStatus;
  failure?: string;
  /** ISO time the session reports as `createdAt`; a fixed past time when absent. */
  createdAt?: string;
  events: { pending: number; submitted: number; failed: number };
  /** Committed entries, in id order. */
  entries: { id: number; kind: string; messages: EntryMessage[] }[];
}

export interface StreamFailure {
  status: number;
  retryAfter?: number;
  body?: unknown;
}

interface Internal extends FakeSession {
  lastLive: LiveData | undefined;
  connections: Set<ServerResponse>;
  connectionCount: number;
  failNext: StreamFailure[];
  waiters: { count: number; resolve: () => void }[];
}

export const user = (text: string): EntryMessage => ({ role: "user", text });
export const assistant = (text: string): EntryMessage => ({ role: "assistant", text });

export class FakeApi {
  readonly token = "test-token-0123456789";
  readonly requests: RecordedRequest[] = [];
  /** When set, every request is answered with a 307 to this URL. */
  redirectTo: string | undefined;
  /** Status of the next `POST /sessions` instead of creating one (e.g. 400). */
  /** The status a DELETE answers with; ingest says "deleting" while cleanup is still running. */
  deleteStatus: "deleting" | "deleted" = "deleted";
  failNextCreate: { status: number; error: string } | undefined;
  readonly #sessions = new Map<string, Internal>();
  readonly #sourceEvents = new Map<string, { sessionId: string; eventId: string }>();
  readonly #server: Server;
  #nextEntryId = new Map<string, number>();

  private constructor() {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  static async start(): Promise<FakeApi> {
    const fake = new FakeApi();
    await new Promise<void>((resolve) => fake.#server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  /** Ends open streams and stops the server. */
  async close(): Promise<void> {
    for (const s of this.#sessions.values()) for (const c of s.connections) c.destroy();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Adds a session (a fresh UUID unless `id` is given). The returned object is live: mutate it to script state. */
  addSession(
    init: Partial<Omit<FakeSession, "events">> & { events?: Partial<FakeSession["events"]> } = {},
  ): FakeSession {
    const session: Internal = {
      id: init.id ?? randomUUID(),
      status: init.status ?? "active",
      ...(init.failure === undefined ? {} : { failure: init.failure }),
      ...(init.createdAt === undefined ? {} : { createdAt: init.createdAt }),
      events: { pending: 0, submitted: 0, failed: 0, ...init.events },
      entries: init.entries ?? [],
      lastLive: undefined,
      connections: new Set(),
      connectionCount: 0,
      failNext: [],
      waiters: [],
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  session(id: string): FakeSession {
    return this.#internal(id);
  }

  /** Requests of one kind, e.g. `api.requestsTo("POST", "/events")` (path suffix match). */
  requestsTo(method: string, pathSuffix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.endsWith(pathSuffix));
  }

  /** Commits an entry: streamed with `id:`/`event: entry` to open connections and replayed to later ones. Returns its id. */
  pushEntry(
    sessionId: string,
    message: EntryMessage | EntryMessage[],
    opts: { id?: number; kind?: string } = {},
  ): number {
    const s = this.#internal(sessionId);
    const id = opts.id ?? (this.#nextEntryId.get(sessionId) ?? 0) + 1;
    this.#nextEntryId.set(sessionId, id);
    const entry = {
      id,
      kind: opts.kind ?? "message",
      messages: Array.isArray(message) ? message : [message],
    };
    s.entries.push(entry);
    for (const c of s.connections) c.write(entryFrame(entry));
    return id;
  }

  /** Sends a `live` event (no id) to open connections; later connections get the latest one on connect. */
  pushLive(sessionId: string, live: LiveData): void {
    const s = this.#internal(sessionId);
    s.lastLive = live;
    for (const c of s.connections) c.write(liveFrame(live));
  }

  /** Sends a raw SSE frame (e.g. a keepalive comment or a malformed event) to open connections. */
  pushRaw(sessionId: string, frame: string): void {
    for (const c of this.#internal(sessionId).connections) c.write(frame);
  }

  /** The session is gone: `event: deleted` on open streams, which then end. Later reads answer 410. */
  pushDeleted(sessionId: string): void {
    const s = this.#internal(sessionId);
    s.status = "deleted";
    for (const c of s.connections) {
      c.write("event: deleted\ndata: {}\n\n");
      c.end();
    }
    s.connections.clear();
  }

  /** Closes open stream connections mid-stream (no `deleted` event), as an orchestrator restart would. */
  dropStreams(sessionId: string): void {
    const s = this.#internal(sessionId);
    for (const c of s.connections) c.end();
    s.connections.clear();
  }

  /** The next stream connection(s) answer this error instead of opening (queued, one per connection). */
  failNextStream(sessionId: string, failure: StreamFailure): void {
    this.#internal(sessionId).failNext.push(failure);
  }

  /** Stream connections opened so far (including failed ones). */
  streamConnections(sessionId: string): number {
    return this.#internal(sessionId).connectionCount;
  }

  /** Stream connections that are open right now (to check that nothing leaks). */
  openStreams(sessionId: string): number {
    return this.#internal(sessionId).connections.size;
  }

  /** Resolves once at least `count` stream connections have been opened for the session. */
  waitForStream(sessionId: string, count = 1): Promise<void> {
    const s = this.#internal(sessionId);
    if (s.connectionCount >= count) return Promise.resolve();
    return new Promise((resolve) => s.waiters.push({ count, resolve }));
  }

  #internal(id: string): Internal {
    const s = this.#sessions.get(id);
    if (s === undefined) throw new Error(`fake api: no session ${id}`);
    return s;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: unknown = raw === "" ? undefined : raw;
    try {
      if (raw !== "") body = JSON.parse(raw);
    } catch {
      // keep the raw text
    }
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    this.requests.push({ method, path, headers: { ...req.headers }, body });

    if (this.redirectTo !== undefined) {
      res.writeHead(307, { location: this.redirectTo });
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    const parts = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
    if (parts[0] !== "sessions") {
      json(res, 404, { error: "not found" });
      return;
    }
    if (parts.length === 1 && method === "POST") {
      this.#create(res);
      return;
    }
    const session = parts[1] === undefined ? undefined : this.#sessions.get(parts[1]);
    if (session === undefined) {
      json(res, 404, { error: "session not found" });
      return;
    }

    if (parts.length === 2 && method === "GET") {
      json(res, 200, summary(session));

      return;
    }
    if (parts.length === 2 && method === "DELETE") {
      if (session.status !== "deleted") this.pushDeleted(session.id);
      json(res, 202, { sessionId: session.id, status: this.deleteStatus });
      return;
    }
    if (parts[2] === "events" && method === "POST") {
      this.#postEvent(res, session, body);
      return;
    }
    if (parts[2] === "stream" && method === "GET") {
      this.#stream(req, res, session);
      return;
    }
    json(res, 404, { error: "not found" });
  }

  #create(res: ServerResponse): void {
    if (this.failNextCreate !== undefined) {
      const { status, error } = this.failNextCreate;
      this.failNextCreate = undefined;
      json(res, status, { error });
      return;
    }
    const s = this.addSession();
    json(res, 201, {
      sessionId: s.id,
      profile: { name: "coding", version: 1 },
      provider: "fake",
      model: "fake-model",
    });
  }

  #postEvent(res: ServerResponse, s: Internal, body: unknown): void {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (b.kind !== "message" && b.kind !== "cancel") {
      json(res, 400, { error: "kind must be message, steer or cancel" });
      return;
    }
    if (b.kind === "message" && (typeof b.text !== "string" || b.text.trim() === "")) {
      json(res, 400, { error: "message needs a non-empty text" });
      return;
    }
    if (s.status !== "active") {
      json(res, s.status === "deleted" ? 410 : 409, { error: `session is ${s.status}` });
      return;
    }
    const sourceEventId = typeof b.sourceEventId === "string" ? b.sourceEventId : undefined;
    const known = sourceEventId === undefined ? undefined : this.#sourceEvents.get(sourceEventId);
    if (known !== undefined) {
      if (known.sessionId !== s.id) {
        json(res, 409, { error: "sourceEventId was already used for another session" });
        return;
      }
      json(res, 202, { eventId: known.eventId, duplicate: true });
      return;
    }
    const eventId = randomUUID();
    if (sourceEventId !== undefined)
      this.#sourceEvents.set(sourceEventId, { sessionId: s.id, eventId });
    if (b.kind === "message") s.events.pending += 1;
    json(res, 202, { eventId, duplicate: false });
  }

  #stream(req: IncomingMessage, res: ServerResponse, s: Internal): void {
    s.connectionCount += 1;
    for (const w of s.waiters.filter((x) => s.connectionCount >= x.count)) w.resolve();
    s.waiters = s.waiters.filter((x) => s.connectionCount < x.count);

    const failure = s.failNext.shift();
    if (failure !== undefined) {
      json(
        res,
        failure.status,
        failure.body ?? { error: "scripted failure" },
        failure.retryAfter === undefined ? {} : { "retry-after": String(failure.retryAfter) },
      );
      return;
    }
    if (s.status === "deleted" || s.status === "deleting") {
      json(res, 410, { error: "session deleted" });
      return;
    }

    const header = req.headers["last-event-id"];
    const cursor = Number(Array.isArray(header) ? header[0] : header);
    const after = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("retry: 2000\n\n");
    for (const e of s.entries) if (e.id > after) res.write(entryFrame(e));
    if (s.lastLive !== undefined) res.write(liveFrame(s.lastLive));
    s.connections.add(res);
    res.on("close", () => s.connections.delete(res));
  }
}

function summary(s: Internal): Record<string, unknown> {
  return {
    sessionId: s.id,
    status: s.status,
    model: { provider: "fake", model: "fake-model" },
    profile: { name: "coding", version: 1 },
    ...(s.failure === undefined ? {} : { failure: s.failure }),
    createdAt: s.createdAt ?? "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    events: s.events,
  };
}

function entryFrame(e: { id: number; kind: string; messages: EntryMessage[] }): string {
  return `id: ${String(e.id)}\nevent: entry\ndata: ${JSON.stringify(e)}\n\n`;
}

function liveFrame(live: LiveData): string {
  return `event: live\ndata: ${JSON.stringify(live)}\n\n`;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
