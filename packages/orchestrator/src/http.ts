import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  errorMessage,
  getSession,
  readBodyText,
  sendBodyError,
  sendJson,
  UUID,
} from "@pi-durable-k8s/session-core";
import type { Authenticator } from "@pi-durable-k8s/session-core";
import type pg from "pg";
import type { Host } from "./host.js";
import { log } from "./log.js";
import { parseScript } from "./model.js";
import type { SessionService } from "./sessions.js";
import { serveStream } from "./stream.js";

/** What /readyz reports: ready only once this process holds the storage lock and the Harness is open. */
export interface Lifecycle {
  state: "waiting-for-lock" | "owner";
  instance: string;
  host?: Host;
  service?: SessionService;
}

export interface ServerDeps {
  lifecycle: Lifecycle;
  authenticate: Authenticator;
  /** For the owner check on the stream. Independent of the Pi Durable storage connection. */
  pool: pg.Pool;
  /** The shard this orchestrator serves; a stream for a session of another shard is refused (docs/decisions/0017). */
  shard: number;
  /** Mounts the test-only /control surface (PI_ORCH_CONTROL=1). */
  control: boolean;
}

const readBody = (req: IncomingMessage): Promise<string> => readBodyText(req, 64 * 1024);

/**
 * The orchestrator's HTTP surface.
 *   GET /healthz                  liveness: 200 while the process runs
 *   GET /readyz                   200 once this process owns the schema and serves, else 503
 *   GET /sessions/{id}/stream     SSE; bearer token + owner check, the same Authenticator as ingest
 *   /control/...                  test-only (PI_ORCH_CONTROL=1): the Phase 3 scripted-session surface, same auth
 */
export function createOrchestratorServer(deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      log("http-error", { message: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const { lifecycle } = deps;
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok", state: lifecycle.state, instance: lifecycle.instance });
    return;
  }
  if (method === "GET" && url.pathname === "/readyz") {
    const ready = lifecycle.host !== undefined && lifecycle.service !== undefined;
    sendJson(res, ready ? 200 : 503, { state: lifecycle.state, instance: lifecycle.instance });
    return;
  }

  const principal = await deps.authenticate(req.headers);
  if (principal === undefined) {
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }

  const { host, service } = lifecycle;
  if (host === undefined || service === undefined) {
    // Not the owner yet (starting, or waiting for the lock). Clients retry; ingest keeps accepting events.
    sendJson(res, 503, { error: lifecycle.state }, { "retry-after": "2" });
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "stream") {
    const id = parts[1] ?? "";
    const session = UUID.test(id) ? await getSession(deps.pool, id) : undefined;
    if (session?.ownerSubject !== principal.subject) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    // Before `ensureConversation`: a misrouted stream must never create a conversation in this shard's schema.
    if (session.shard !== deps.shard) {
      sendJson(res, 421, { error: "session belongs to another shard" });
      return;
    }
    // `deleting` is refused too: deletion closes the open streams once, so one admitted afterwards would never end.
    if (session.status === "deleted" || session.status === "deleting") {
      sendJson(res, 410, { error: "session deleted" });
      return;
    }
    const conversationId = await service.ensureConversation(session);
    await serveStream(req, res, host, service.streams, session.id, conversationId, async () => {
      const current = await getSession(deps.pool, session.id);
      return current !== undefined && current.status !== "deleted" && current.status !== "deleting";
    });
    return;
  }

  if (deps.control && parts[0] === "control") {
    await handleControl(req, res, host, method, parts.slice(1));
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

/**
 * Test-only. Scripted sessions created straight on the Harness, not through the inbox, with the sandbox claim
 * created eagerly. Kept only so the Phase 3 failure tests keep running unchanged in substance.
 *   POST /control/sessions            body = script JSON
 *   POST /control/sessions/:id/inputs body = script JSON
 *   GET  /control/sessions/:id        status and tool results
 */
async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  host: Host,
  method: string,
  parts: string[],
): Promise<void> {
  if (parts[0] !== "sessions") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (method === "POST" && parts.length === 1) {
    let script;
    try {
      script = parseScript(await readBody(req));
    } catch (error) {
      sendBodyError(res, req, error);
      return;
    }
    sendJson(res, 201, await host.startSession(script));
    return;
  }
  const id = Number(parts[1]);
  if (method === "POST" && parts[2] === "inputs") {
    let script;
    try {
      script = parseScript(await readBody(req));
    } catch (error) {
      sendBodyError(res, req, error);
      return;
    }
    const known = Number.isInteger(id) && (await host.sendInput(id, script));
    sendJson(res, known ? 202 : 404, known ? { id } : { error: "unknown session" });
    return;
  }
  if (method === "GET" && parts.length === 2 && Number.isInteger(id)) {
    const status = await host.status(id);
    sendJson(res, status === undefined ? 404 : 200, status ?? { error: "unknown session" });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}
