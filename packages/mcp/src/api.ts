/**
 * Client of the session API (docs/session-api.md): the `/sessions` routes, and `/admin/*` through `admin` for the opt-in
 * admin tools (ADR 0050), each instance with its own token. It parses JSON bodies but not the SSE stream: `openStream`
 * hands the raw response to the reader.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_CHARS = 300;

export type SessionStatus = "active" | "failed" | "deleting" | "deleted";

export interface CreateSessionInput {
  profile?: string;
  repo?: string;
  branch?: string;
  /** Desktop profiles only: also mint a public view-only live view and return its URL. */
  liveView?: boolean;
}

export interface CreatedSession {
  sessionId: string;
  profile: { name: string; version: number };
  provider: string;
  model: string;
  reasoning?: string;
  /** Present when the session was created with `liveView`. A secret: anyone who has it can watch. */
  liveViewUrl?: string;
}

export interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  model: { provider: string; model: string; reasoning?: string };
  profile: { name: string; version: number };
  repo?: string;
  /** Untrusted text from the server. */
  failure?: string;
  createdAt: string;
  lastActivityAt: string;
  events: { pending: number; submitted: number; failed: number };
}

/** One row of `GET /sessions`: metadata only, never a transcript. */
export interface SessionListEntry {
  id: string;
  status: SessionStatus;
  profile: { name: string; version: number };
  model: { provider: string; model: string; reasoning?: string };
  repo?: { repo: string; branch?: string };
  createdAt: string;
  lastActivityAt: string;
}

export interface SessionListPage {
  sessions: SessionListEntry[];
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface SessionListQuery {
  status?: SessionStatus;
  limit?: number;
  cursor?: string;
}

/** One row of `GET /events`. `data` can hold a session's failure text, which is untrusted. */
export interface FeedEntry {
  id: string;
  type: string;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string;
}

export interface FeedPage {
  events: FeedEntry[];
  cursor: string;
  hasMore: boolean;
  truncated: boolean;
}

export interface FeedQuery {
  cursor?: string;
  limit?: number;
}

/** Ingest's answer to a delete: "deleting" while cleanup runs, "deleted" once it is done. */
export interface DeletedSession {
  status: "deleting" | "deleted";
}

export type SessionEventInput = { kind: "message"; text: string; sourceEventId?: string };

export interface PostedEvent {
  eventId: string;
  /** True when `sourceEventId` was already used for this session: nothing new was queued. */
  duplicate: boolean;
}

/** A failed call. `status` is 0 when no HTTP answer came (network error, redirect, timeout). Never holds the token. */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds, from a `Retry-After` header. */
  readonly retryAfter: number | undefined;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface SessionApiOptions {
  apiUrl: string;
  token: string;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export class SessionApi {
  readonly #base: string;
  readonly #token: string;

  constructor(options: SessionApiOptions) {
    this.#base = options.apiUrl.replace(/\/+$/, "");
    this.#token = options.token;
  }

  async createSession(
    input: CreateSessionInput = {},
    signal?: AbortSignal,
  ): Promise<CreatedSession> {
    const session = await this.#json<unknown>("POST", "/sessions", 201, input, signal);
    if (
      typeof session !== "object" ||
      session === null ||
      !("sessionId" in session) ||
      typeof session.sessionId !== "string" ||
      !UUID.test(session.sessionId)
    ) {
      throw new ApiError(0, "session API answered without a valid session id");
    }
    return session as CreatedSession;
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionSummary> {
    return this.#json<SessionSummary>("GET", sessionPath(sessionId), 200, undefined, signal);
  }

  /** `GET /sessions`: the caller's own sessions, newest first. */
  async listSessions(query: SessionListQuery = {}, signal?: AbortSignal): Promise<SessionListPage> {
    return this.#json<SessionListPage>(
      "GET",
      withQuery("/sessions", query),
      200,
      undefined,
      signal,
    );
  }

  /** `GET /events`: one page of the caller's own feed, oldest first. */
  async listEvents(query: FeedQuery = {}, signal?: AbortSignal): Promise<FeedPage> {
    return this.#json<FeedPage>("GET", withQuery("/events", query), 200, undefined, signal);
  }

  async postEvent(
    sessionId: string,
    event: SessionEventInput | { kind: "cancel" },
    signal?: AbortSignal,
  ): Promise<PostedEvent> {
    return this.#json<PostedEvent>("POST", `${sessionPath(sessionId)}/events`, 202, event, signal);
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<DeletedSession> {
    return this.#json<DeletedSession>("DELETE", sessionPath(sessionId), 202, undefined, signal);
  }

  /** `PUT /sessions/{id}/live-view`: mints a new public view-only URL each time, so an earlier one stops working. */
  async enableLiveView(sessionId: string, signal?: AbortSignal): Promise<string> {
    const body = await this.#json<unknown>(
      "PUT",
      `${sessionPath(sessionId)}/live-view`,
      200,
      undefined,
      signal,
    );
    if (
      typeof body !== "object" ||
      body === null ||
      !("liveViewUrl" in body) ||
      typeof body.liveViewUrl !== "string" ||
      body.liveViewUrl === ""
    ) {
      throw new ApiError(0, "session API answered without a live view URL");
    }
    return body.liveViewUrl;
  }

  /** `DELETE /sessions/{id}/live-view`: revokes the URL. Idempotent: 204 whether or not one was on. */
  async disableLiveView(sessionId: string, signal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.#fetch(
      "DELETE",
      `${sessionPath(sessionId)}/live-view`,
      {},
      undefined,
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );
    if (res.status !== 204) throw await this.errorFromResponse(res);
  }

  /**
   * Opens `GET /sessions/{id}/stream` and returns the response as it is, whatever its status: the reader maps 503
   * (Retry-After) and 410 itself, see `errorFromResponse`. No request timeout; `signal` ends the stream.
   * `cursor` is the id of the last entry seen (sent as `Last-Event-ID`); absent replays the whole transcript.
   */
  async openStream(
    sessionId: string,
    cursor: number | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const path = `${sessionPath(sessionId)}/stream`;
    if (cursor !== undefined && !(Number.isSafeInteger(cursor) && cursor > 0)) {
      throw new ApiError(0, "cursor must be a positive integer");
    }
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (cursor !== undefined) headers["last-event-id"] = String(cursor);
    return this.#fetch("GET", path, headers, undefined, signal);
  }

  /**
   * One admin API call (ADR 0050): `path` must start with `/admin/` and be built from validated, encoded parts. Any 2xx
   * answer is its JSON body; anything else is an `ApiError` with the server's text, scrubbed of this client's token.
   */
  async admin(
    method: "GET" | "PUT" | "DELETE",
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!path.startsWith("/admin/")) throw new ApiError(0, "not an admin path");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.#fetch(
      method,
      path,
      payload === undefined ? {} : { "content-type": "application/json" },
      payload === undefined ? undefined : JSON.stringify(payload),
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );
    if (!res.ok) throw await this.errorFromResponse(res);
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new ApiError(res.status, "admin API answered with a body that is not JSON");
    }
  }

  /** The error for a non-success response, with the server's `error` text. Consumes the body. */
  async errorFromResponse(res: Response): Promise<ApiError> {
    let message = `session API answered ${String(res.status)}`;
    try {
      const body: unknown = JSON.parse(await res.text());
      if (typeof body === "object" && body !== null && "error" in body) {
        const text = body.error;
        if (typeof text === "string" && text !== "") message = text;
      }
    } catch {
      // not JSON: keep the generic message
    }
    return new ApiError(
      res.status,
      this.#scrub(message.slice(0, MAX_MESSAGE_CHARS)),
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  #scrub(text: string): string {
    return text.split(this.#token).join("[redacted]");
  }

  async #fetch(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await fetch(`${this.#base}${path}`, {
        method,
        headers: { ...headers, authorization: `Bearer ${this.#token}` },
        ...(body === undefined ? {} : { body }),
        // A redirect would resend the bearer token to another place.
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // A caller's abort is not a failure of the API; our own timeout is.
      if (
        signal?.aborted === true &&
        (signal.reason as Error | undefined)?.name !== "TimeoutError"
      ) {
        throw error;
      }
      // The cause of a fetch failure can name the URL; keep only the error code.
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      const detail = typeof code === "string" ? ` (${code})` : "";
      throw new ApiError(0, `session API request failed${detail}`);
    }
  }

  async #json<T>(
    method: string,
    path: string,
    expected: number,
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.#fetch(
      method,
      path,
      payload === undefined ? {} : { "content-type": "application/json" },
      payload === undefined ? undefined : JSON.stringify(payload),
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    );
    if (res.status !== expected) throw await this.errorFromResponse(res);
    return (await res.json()) as T;
  }
}

/** `path` with the defined fields of `query` as an encoded query string. */
function withQuery(path: string, query: SessionListQuery | FeedQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query) as [string, string | number | undefined][]) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** Refuses anything but a UUID before it can reach a URL. */
function sessionPath(sessionId: string): string {
  if (!UUID.test(sessionId)) throw new ApiError(0, "sessionId is not a valid session id");
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
