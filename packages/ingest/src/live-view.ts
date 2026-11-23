import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { extname } from "node:path";
import {
  errorMessage,
  isWebSocketKey,
  joinSockets,
  LIVE_VIEW_ORCH_PREFIX,
  LIVE_VIEW_TOKEN_HEADER,
  refuseUpgrade,
  safeSubprotocol,
  sessionByLiveViewToken,
  switchingProtocols,
  websocketAccept,
} from "@cela/session-core";
import type pg from "pg";
import { orchestratorUrlFor } from "./config.js";
import { CONTENT_TYPES, fileFor } from "./console.js";
import { log } from "./log.js";

/** The public live view of a desktop session (issue #418, ADR 0066): the one unauthenticated dynamic route of ingest. */
export const LIVE_PREFIX = "/live/";
const ASSETS = "_assets/";
/** A token is 32 random bytes in base64url. Anything else is not looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface LiveViewDeps {
  pool: Pick<pg.Pool, "query">;
  /** `PI_LIVE_VIEW_PUBLIC_URL`; undefined: the live view is off and every `/live/*` request is a 404. */
  publicUrl: string | undefined;
  /** Directory of the viewer page, its script and the noVNC modules (`PI_LIVE_VIEW_DIR`). */
  dir: string | undefined;
  orchestratorUrl: string;
}

export const isLivePath = (pathname: string): boolean => pathname.startsWith(LIVE_PREFIX);

/** The URL a viewer opens; the token is the whole credential. */
export const liveViewUrl = (publicUrl: string, token: string): string =>
  `${publicUrl}${LIVE_PREFIX}${token}`;

/**
 * Headers for the viewer page and its assets. Nothing inline, and the page may connect only to its own origin (the
 * WebSocket). The token is in the URL, so the page must never leak it: no referrer, no indexing, no caching.
 */
function setLiveHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-robots-tag", "noindex");
}

/** One body for everything that is not a valid live view: an unknown, a rotated and a deleted token look alike. */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string | undefined,
): Promise<void> {
  if (file === undefined) {
    notFound(res);
    return;
  }
  const size = (await stat(file)).size;
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(size),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/**
 * `GET /live/_assets/*` (the viewer's script and the noVNC modules, from the image) and `GET /live/<token>` (the viewer
 * page, only for a token that opens a live session). Served before the bearer gate: the page holds no secret of its own.
 * The Pod never supplies a byte of it, only the WebSocket stream.
 */
export async function serveLive(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: LiveViewDeps,
): Promise<void> {
  setLiveHeaders(res);
  if ((req.method !== "GET" && req.method !== "HEAD") || deps.publicUrl === undefined) {
    notFound(res);
    return;
  }
  const rest = pathname.slice(LIVE_PREFIX.length);
  if (rest.startsWith(ASSETS)) {
    const file =
      deps.dir === undefined ? undefined : await fileFor(deps.dir, rest.slice(ASSETS.length));
    await sendFile(req, res, file);
    return;
  }
  if (!TOKEN.test(rest) || deps.dir === undefined) {
    notFound(res);
    return;
  }
  const session = await sessionByLiveViewToken(deps.pool, rest);
  if (session?.status !== "active") {
    notFound(res);
    return;
  }
  await sendFile(req, res, await fileFor(deps.dir, "viewer.html"));
}

/**
 * `GET /live/<token>/ws` as a WebSocket upgrade: looks the token up, then asks the owning orchestrator shard to connect
 * the session's desktop. Only a 101 from the shard is passed on; any other answer is replaced by a bare status line, so
 * nothing an upstream said reaches the viewer. Ingest never talks to a sandbox itself.
 */
export async function handleLiveUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: LiveViewDeps,
): Promise<void> {
  // Also set by the server's listener; here too so the handler is safe on its own.
  socket.on("error", () => socket.destroy());
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/live\/([A-Za-z0-9_-]{43})\/ws$/.exec(url.pathname);
    const key = req.headers["sec-websocket-key"];
    if (deps.publicUrl === undefined || match === null || !isWebSocketKey(key)) {
      socket.destroy();
      return;
    }
    const token = match[1] ?? "";
    const session = await sessionByLiveViewToken(deps.pool, token);
    if (session?.status !== "active") {
      refuseUpgrade(socket, 404);
      return;
    }
    relay(socket, head, {
      target: new URL(
        `${LIVE_VIEW_ORCH_PREFIX}${session.id}`,
        orchestratorUrlFor(deps.orchestratorUrl, session.shard),
      ),
      token,
      key,
      protocol: safeSubprotocol(req.headers["sec-websocket-protocol"]),
    });
  } catch (error) {
    // Never the URL: it holds the token.
    log("live-view-failed", { message: errorMessage(error) });
    refuseUpgrade(socket, 502);
  }
}

interface Relay {
  target: URL;
  token: string;
  key: string;
  protocol: string | undefined;
}

function relay(client: Duplex, clientHead: Buffer, via: Relay): void {
  const upstream = httpRequest(via.target, {
    method: "GET",
    timeout: 15_000,
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": via.key,
      ...(via.protocol === undefined ? {} : { "sec-websocket-protocol": via.protocol }),
      [LIVE_VIEW_TOKEN_HEADER]: via.token,
    },
  });
  const refuse = (status: number): void => {
    upstream.destroy();
    refuseUpgrade(client, status);
  };
  upstream.on("timeout", () => refuse(503));
  upstream.on("error", () => refuse(503));
  // A refusal keeps its meaning for the page's retry logic (429: full, 404: gone), nothing else of it.
  upstream.on("response", (response) => {
    response.resume();
    const status = response.statusCode ?? 502;
    refuse(status === 404 || status === 429 || status === 503 ? status : 502);
  });
  upstream.on("upgrade", (response, orchestratorSocket, orchestratorHead) => {
    orchestratorSocket.on("error", () => orchestratorSocket.destroy());
    const accept = response.headers["sec-websocket-accept"];
    if (accept !== websocketAccept(via.key) || client.destroyed) {
      orchestratorSocket.destroy();
      refuseUpgrade(client, 502);
      return;
    }
    upstream.setTimeout(0);
    const chosen = response.headers["sec-websocket-protocol"];
    const offered = via.protocol?.split(/, ?/) ?? [];
    client.write(
      switchingProtocols(
        accept,
        typeof chosen === "string" && offered.includes(chosen) ? chosen : undefined,
      ),
    );
    joinSockets(client, orchestratorSocket, clientHead, orchestratorHead, () => undefined);
  });
  // The browser went away before the shard answered.
  client.once("close", () => upstream.destroy());
  upstream.end();
}
