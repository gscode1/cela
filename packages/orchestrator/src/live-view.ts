import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  errorMessage,
  getSession,
  isWebSocketKey,
  LIVE_VIEW_ORCH_PREFIX,
  LIVE_VIEW_PORT,
  LIVE_VIEW_TOKEN_HEADER,
  refuseUpgrade,
  safeSubprotocol,
  sameSecret,
  switchingProtocols,
  UUID,
  websocketAccept,
} from "@cela/session-core";
import type { SessionRow } from "@cela/session-core";
import type pg from "pg";
import { claimNameFor } from "./lifecycle.js";
import { log } from "./log.js";
import { ClientFilter } from "./rfb-filter.js";

const IDLE_MS = 10 * 60_000;

export interface LiveViewOptions {
  pool: Pick<pg.Pool, "query">;
  shard: number;
  /** The Pod IP of a session's sandbox, or undefined while it has none (suspended, starting). Never cached here. */
  podIp: (claimName: string) => Promise<string | undefined>;
  /** Viewers per session and per shard (`PI_LIVE_VIEW_MAX_VIEWERS`); a viewer over either is refused with a 429. */
  maxPerSession: number;
  maxPerShard: number;
  /** How often the tokens of watched sessions are read again; a disabled live view is cut within this time. */
  recheckMs?: number;
  /** websockify's port; only a test changes it. */
  podPort?: number;
  /** A viewer that sent nothing for this long is dropped (default 10 min). noVNC asks for a framebuffer update continuously, so only a dead socket is reaped. */
  idleMs?: number;
}

/** The handshake headers the relay forwards to the Pod, nothing else of the viewer's request reaches it. */
interface Handshake {
  key: string;
  protocol: string | undefined;
}

/**
 * The orchestrator's end of the public live view (ADR 0066): a data-plane hop between ingest, which holds the viewer's
 * connection, and the websockify of the session's desktop Pod. It never creates a conversation, resumes a suspended
 * sandbox or touches the session's activity: watching must neither start nor keep alive what the owner is not using.
 * The Pod is untrusted, so only the WebSocket byte stream crosses, after the Pod answered the handshake correctly.
 */
export class LiveViewProxy {
  readonly #options: LiveViewOptions;
  /** Per session: each viewer's socket and the token it connected with (a rotation makes it stale). */
  readonly #viewers = new Map<string, Map<Duplex, string>>();
  #total = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: LiveViewOptions) {
    this.#options = options;
  }

  /** Viewers connected now, for tests and logs. */
  get viewers(): number {
    return this.#total;
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Node removes its own error listener before it emits `upgrade`: a reset during any await below would otherwise be
    // an unhandled 'error' and end the process.
    socket.on("error", () => socket.destroy());
    try {
      await this.#upgrade(req, socket, head);
    } catch (error) {
      // Never the token: the request carries it in a header.
      log("live-view-failed", { message: errorMessage(error) });
      refuseUpgrade(socket, 502);
    }
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.pathname.startsWith(LIVE_VIEW_ORCH_PREFIX)
      ? url.pathname.slice(LIVE_VIEW_ORCH_PREFIX.length)
      : "";
    const token = req.headers[LIVE_VIEW_TOKEN_HEADER];
    const key = req.headers["sec-websocket-key"];
    if (!UUID.test(id) || typeof token !== "string" || !isWebSocketKey(key)) {
      refuseUpgrade(socket, 400);
      return;
    }
    const protocol = safeSubprotocol(req.headers["sec-websocket-protocol"]);
    const session = await getSession(this.#options.pool, id);
    // The same answer for an unknown session and a wrong token: the route must not say which sessions exist.
    if (
      session === undefined ||
      session.liveViewToken === null ||
      !sameSecret(session.liveViewToken, token)
    ) {
      refuseUpgrade(socket, 404);
      return;
    }
    // Before any Pod lookup: a misrouted viewer must not reach another shard's sandbox namespace entries.
    if (session.shard !== this.#options.shard) {
      refuseUpgrade(socket, 421);
      return;
    }
    const refusal = this.#admission(session);
    if (refusal !== undefined) {
      refuseUpgrade(socket, refusal);
      return;
    }
    // The slot is taken in the same turn as the cap check, before the Pod lookup: a burst of viewers cannot all pass the
    // check and overshoot the caps while their lookups and handshakes are open. Every way out releases it.
    const release = this.#reserve(session.id, socket, token);
    const ip = await this.#options
      .podIp(claimNameFor(this.#options.shard, session.conversationId ?? 0))
      .catch(() => undefined);
    if (ip === undefined || socket.destroyed) {
      release();
      refuseUpgrade(socket, 503);
      return;
    }
    this.#connect(socket, head, ip, { key, protocol }, release);
  }

  /** Counts a viewer in and returns the function that counts it out (idempotent; also run when its socket closes). */
  #reserve(sessionId: string, client: Duplex, token: string): () => void {
    const set = this.#viewers.get(sessionId) ?? new Map<Duplex, string>();
    this.#viewers.set(sessionId, set);
    set.set(client, token);
    this.#total += 1;
    this.#startTimer();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      set.delete(client);
      if (set.size === 0 && this.#viewers.get(sessionId) === set) this.#viewers.delete(sessionId);
      this.#total -= 1;
      if (this.#total === 0) this.#stopTimer();
    };
    client.once("close", release);
    return release;
  }

  /** The status to refuse with, or undefined when the viewer may connect. */
  #admission(session: SessionRow): number | undefined {
    if (session.status !== "active") return 404;
    // No conversation means no sandbox was ever asked for; creating one here would let a stranger spend resources.
    if (session.conversationId === null) return 503;
    if (this.#total >= this.#options.maxPerShard) return 429;
    if ((this.#viewers.get(session.id)?.size ?? 0) >= this.#options.maxPerSession) return 429;
    return undefined;
  }

  #connect(
    client: Duplex,
    clientHead: Buffer,
    ip: string,
    handshake: Handshake,
    release: () => void,
  ): void {
    const upstream = httpRequest({
      host: ip,
      port: this.#options.podPort ?? LIVE_VIEW_PORT,
      path: "/websockify",
      method: "GET",
      timeout: 10_000,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": handshake.key,
        ...(handshake.protocol === undefined
          ? {}
          : { "sec-websocket-protocol": handshake.protocol }),
      },
    });
    const fail = (status: number): void => {
      upstream.destroy();
      release();
      refuseUpgrade(client, status);
    };
    upstream.on("timeout", () => fail(503));
    upstream.on("error", () => fail(503));
    // Anything but 101 is the Pod talking: its status and body are never forwarded.
    upstream.on("response", (response) => {
      response.resume();
      fail(502);
    });
    upstream.on("upgrade", (response, podSocket, podHead) => {
      // Same reason as the viewer's socket: no listener is left on it once the request handed it over.
      podSocket.on("error", () => podSocket.destroy());
      const accept = response.headers["sec-websocket-accept"];
      if (accept !== websocketAccept(handshake.key) || client.destroyed) {
        podSocket.destroy();
        release();
        refuseUpgrade(client, 502);
        return;
      }
      upstream.setTimeout(0);
      // The Pod may only choose among the subprotocols the viewer offered.
      const chosen = response.headers["sec-websocket-protocol"];
      const offered = handshake.protocol?.split(/, ?/) ?? [];
      const protocol = typeof chosen === "string" && offered.includes(chosen) ? chosen : undefined;
      client.write(switchingProtocols(accept, protocol));
      joinFiltered(
        client,
        podSocket,
        clientHead,
        podHead,
        release,
        this.#options.idleMs ?? IDLE_MS,
      );
    });
    upstream.end();
  }

  /** Reads the tokens of watched sessions again and drops every viewer whose token was turned off or replaced. */
  async recheck(): Promise<void> {
    for (const [id, sockets] of [...this.#viewers]) {
      let current: SessionRow | undefined;
      try {
        current = await getSession(this.#options.pool, id);
      } catch (error) {
        // A database blip must not cut viewers; the next round tries again.
        log("live-view-recheck-failed", { message: errorMessage(error) });
        continue;
      }
      const live = current?.status === "active" ? current.liveViewToken : null;
      for (const [socket, token] of sockets) {
        if (live === null || !sameSecret(live, token)) socket.destroy();
      }
    }
  }

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.recheck();
    }, this.#options.recheckMs ?? 5_000);
    this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Drops every viewer and stops re-reading; part of the shutdown. */
  close(): void {
    this.#stopTimer();
    for (const sockets of this.#viewers.values())
      for (const socket of sockets.keys()) socket.destroy();
  }
}

/**
 * Joins the viewer and the Pod. The framebuffer goes to the viewer raw; what the viewer sends goes through the RFB
 * filter first (rfb-filter.ts), so a viewer cannot type or click in the desktop whatever the Pod's VNC server allows.
 */
function joinFiltered(
  client: Duplex,
  pod: Duplex,
  clientHead: Buffer,
  podHead: Buffer,
  onClose: () => void,
  idleMs: number,
): void {
  const filter = new ClientFilter();
  let closed = false;
  let idle: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    client.destroy();
    pod.destroy();
    onClose();
  };
  // Only what the viewer sends counts: the Pod's framebuffer traffic must not keep a dead viewer alive.
  const armIdle = (): void => {
    clearTimeout(idle);
    idle = setTimeout(close, idleMs);
    idle.unref();
  };
  armIdle();
  const fromViewer = (chunk: Buffer): void => {
    armIdle();
    const { out, close: stop } = filter.push(chunk);
    // A slow Pod must not make the orchestrator buffer a fast viewer's bytes without limit.
    if (out.length > 0 && !pod.write(out)) {
      client.pause();
      pod.once("drain", () => client.resume());
    }
    if (stop) close();
  };
  for (const socket of [client, pod]) {
    socket.on("error", close);
    socket.on("close", close);
    // A peer that half-closes would otherwise leave the viewer's slot taken.
    socket.on("end", close);
  }
  if (podHead.length > 0) client.write(podHead);
  if (clientHead.length > 0) fromViewer(clientHead);
  client.on("data", fromViewer);
  pod.pipe(client);
}
