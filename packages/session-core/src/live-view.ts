import { createHash, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

/**
 * The pieces of the public live view (issue #418, ADR 0066) that ingest and the orchestrator must agree on. The viewer's
 * WebSocket goes browser -> ingest -> orchestrator -> the sandbox's websockify; each hop validates the handshake itself
 * and relays only what is listed here, because the sandbox Pod is untrusted and the viewer is anonymous.
 */

/** The orchestrator route ingest upgrades to: `/live-view/<session id>`. */
export const LIVE_VIEW_ORCH_PREFIX = "/live-view/";

/** Carries the viewer's token from ingest to the orchestrator, which checks it against the session row again. */
export const LIVE_VIEW_TOKEN_HEADER = "x-live-view-token";

/** The port websockify listens on in a desktop sandbox (images/sandbox-desktop). */
export const LIVE_VIEW_PORT = 6080;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** A `Sec-WebSocket-Key`: 16 random bytes in base64. */
export const isWebSocketKey = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]{22}==$/.test(value);

/** What a server must answer for `key` (RFC 6455, 4.2.2). */
export const websocketAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");

/** A subprotocol list the relay may pass on: tokens only, so a value cannot carry a header break. */
export const safeSubprotocol = (value: unknown): string | undefined =>
  typeof value === "string" && /^[\w.-]+(, ?[\w.-]+)*$/.test(value) ? value : undefined;

/** Compares two secrets in constant time regardless of their lengths. */
export function sameSecret(a: string, b: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The 101 response a relay writes: only the headers a WebSocket client needs, never the ones the Pod sent. */
export function switchingProtocols(accept: string, protocol: string | undefined): string {
  return (
    "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
    `sec-websocket-accept: ${accept}\r\n` +
    (protocol === undefined ? "" : `sec-websocket-protocol: ${protocol}\r\n`) +
    "\r\n"
  );
}

const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  404: "Not Found",
  421: "Misdirected Request",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Answers a refused upgrade with a bare status line (no body, no upstream text) and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const retry = status === 503 || status === 429 ? "retry-after: 2\r\n" : "";
  socket.end(
    `HTTP/1.1 ${String(status)} ${REASONS[status] ?? "Error"}\r\ncontent-length: 0\r\nconnection: close\r\n${retry}\r\n`,
  );
}

/** Joins two sockets until either ends; `onClose` runs once. Everything the client sent early (`head`) is passed on. */
export function joinSockets(
  client: Duplex,
  upstream: Duplex,
  clientHead: Buffer,
  upstreamHead: Buffer,
  onClose: () => void,
): void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
    onClose();
  };
  for (const socket of [client, upstream]) {
    socket.on("error", close);
    socket.on("close", close);
    socket.on("end", close);
  }
  if (upstreamHead.length > 0) client.write(upstreamHead);
  if (clientHead.length > 0) upstream.write(clientHead);
  client.pipe(upstream);
  upstream.pipe(client);
}
