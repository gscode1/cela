import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import type pg from "pg";
import {
  BodyError,
  chooseModel,
  chooseRepo,
  createSession,
  deleteEventKey,
  enqueueEvent,
  errorMessage,
  getSession,
  readJsonObject,
  requestDelete,
  sendJson,
  summarize,
  UUID,
} from "@pi-durable-k8s/session-core";
import type {
  Authenticator,
  ModelChoice,
  ModelPolicy,
  Principal,
  SessionRow,
} from "@pi-durable-k8s/session-core";
import { parseEventBody } from "./events.js";
import { log } from "./log.js";

export interface IngestDeps {
  pool: pg.Pool;
  authenticate: Authenticator;
  orchestratorUrl: string;
  models: ModelPolicy;
  /** False until the inbox schema is migrated; liveness does not wait for it, readiness and the API do. */
  schemaReady: () => boolean;
}

export function createIngestServer(deps: IngestDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      log("http-error", { message: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: IngestDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && url.pathname === "/readyz") {
    // Ready means "can accept events": the schema is migrated and the database answers. The orchestrator is
    // deliberately not checked.
    if (!deps.schemaReady()) {
      sendJson(res, 503, { status: "migrating" });
      return;
    }
    try {
      await deps.pool.query("select 1");
      sendJson(res, 200, { status: "ready" });
    } catch {
      sendJson(res, 503, { status: "database unavailable" });
    }
    return;
  }

  if (!deps.schemaReady()) {
    sendJson(res, 503, { error: "starting" }, { "retry-after": "2" });
    return;
  }

  // Every route below is behind this one check.
  const principal = await deps.authenticate(req.headers);
  if (principal === undefined) {
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }

  if (method === "POST" && url.pathname === "/sessions") {
    await postSession(req, res, deps, principal);
    return;
  }
  if (parts[0] !== "sessions" || parts[1] === undefined) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const session = await ownedSession(deps.pool, parts[1], principal);
  if (session === undefined) {
    // Unknown id and someone else's id look the same: the API does not reveal that a session exists.
    sendJson(res, 404, { error: "session not found" });
    return;
  }

  if (parts.length === 2 && method === "GET") {
    const summary = await summarize(deps.pool, session);
    sendJson(res, 200, {
      sessionId: session.id,
      status: summary.status,
      model: modelOf(session, deps.models),
      ...(session.repo === null ? {} : { repo: session.repo }),
      ...(session.failure === null ? {} : { failure: session.failure }),
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: summary.lastActivityAt.toISOString(),
      events: summary.events,
    });
    return;
  }
  if (parts.length === 2 && method === "DELETE") {
    await queueDelete(deps.pool, session, res);
    return;
  }
  if (parts.length === 3 && parts[2] === "events" && method === "POST") {
    await postEvent(req, res, deps.pool, session, principal);
    return;
  }
  if (parts.length === 3 && parts[2] === "stream" && method === "GET") {
    if (session.status === "deleted") {
      sendJson(res, 410, { error: "session deleted" });
      return;
    }
    proxyStream(req, res, deps.orchestratorUrl, session.id);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

/** Sessions that predate migration 002 have no stored model: they run the default. */
function modelOf(session: SessionRow, policy: ModelPolicy): ModelChoice {
  return session.model ?? policy.default;
}

async function postSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    if (error instanceof BodyError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
  }
  const model = chooseModel(deps.models, body);
  if (typeof model === "string") {
    sendJson(res, 400, { error: model });
    return;
  }
  const repo = chooseRepo(body);
  if (typeof repo === "string") {
    sendJson(res, 400, { error: repo });
    return;
  }
  const sessionId = await createSession(deps.pool, principal, model, repo);
  sendJson(res, 201, {
    sessionId,
    provider: model.provider,
    model: model.model,
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(repo === undefined
      ? {}
      : { repo: repo.repo, ...(repo.branch === undefined ? {} : { branch: repo.branch }) }),
  });
}

async function ownedSession(
  pool: pg.Pool,
  id: string,
  principal: Principal,
): Promise<SessionRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const session = await getSession(pool, id);
  return session?.ownerSubject === principal.subject ? session : undefined;
}

async function postEvent(
  req: IncomingMessage,
  res: ServerResponse,
  pool: pg.Pool,
  session: SessionRow,
  principal: Principal,
): Promise<void> {
  let parsed;
  try {
    parsed = parseEventBody(await readJsonObject(req));
  } catch (error) {
    if (error instanceof BodyError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
  }
  if (typeof parsed === "string") {
    sendJson(res, 400, { error: parsed });
    return;
  }
  if (session.status !== "active") {
    sendJson(res, session.status === "deleted" ? 410 : 409, {
      error: `session is ${session.status}`,
    });
    return;
  }
  const result = await enqueueEvent(pool, {
    sessionId: session.id,
    source: `api:${principal.owner}`,
    sourceEventId: parsed.sourceEventId,
    kind: parsed.kind,
    payload: parsed.payload,
  });
  if (result.outcome === "conflict") {
    sendJson(res, 409, { error: "sourceEventId was already used for another session" });
    return;
  }
  // 202 either way: a repeated post is accepted and names the first event.
  sendJson(res, 202, { eventId: result.eventId, duplicate: result.outcome === "duplicate" });
}

async function queueDelete(pool: pg.Pool, session: SessionRow, res: ServerResponse): Promise<void> {
  if (session.status === "deleted") {
    sendJson(res, 202, { sessionId: session.id, status: "deleted" });
    return;
  }
  // The delete is an inbox row like any other, so it runs after the events accepted before it.
  const result = await enqueueEvent(pool, {
    sessionId: session.id,
    ...deleteEventKey(session.id),
    kind: "delete",
    payload: {},
  });
  await requestDelete(pool, session.id);
  const eventId = result.outcome === "conflict" ? undefined : result.eventId;
  sendJson(res, 202, { sessionId: session.id, status: "deleting", eventId });
}

/**
 * Pipes the orchestrator's SSE stream to the client. The orchestrator authenticates the same token again.
 * When the upstream ends (orchestrator restart) the client's response ends too; the client reconnects
 * with Last-Event-ID and resumes.
 */
function proxyStream(
  req: IncomingMessage,
  res: ServerResponse,
  orchestratorUrl: string,
  sessionId: string,
): void {
  const target = new URL(`/sessions/${sessionId}/stream`, orchestratorUrl);
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (typeof req.headers.authorization === "string")
    headers.authorization = req.headers.authorization;
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string") headers["last-event-id"] = lastEventId;

  const upstream = httpRequest(target, { method: "GET", headers }, (up) => {
    const type = up.headers["content-type"];
    res.writeHead(up.statusCode ?? 502, {
      "content-type": typeof type === "string" ? type : "application/json",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    up.pipe(res);
    up.on("error", () => res.end());
  });
  upstream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 503, { error: "orchestrator unavailable, retry" }, { "retry-after": "2" });
    } else {
      res.end();
    }
  });
  res.on("close", () => upstream.destroy());
  // The orchestrator sends a keepalive every 15 s. Silence for 45 s means it is gone without closing the
  // connection (node lost, network cut): drop the stream so the client reconnects instead of waiting forever.
  upstream.setTimeout(45_000, () => upstream.destroy());
  upstream.end();
}
