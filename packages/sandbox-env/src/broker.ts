import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBridge } from "./bridge.js";
import type { StartProcess } from "./bridge.js";

/** The relay's first line on each of its two connections (relay.ts writes it; keep the two in step). */
export interface RelayHeader {
  nonce: string;
  /** `log` carries the bridge's stderr lines to the relay's stderr; `data` carries the pi-env byte stream. */
  role: "log" | "data";
  /** `serve --token <hex>`: what pi-env's Connection appended to the relay's argv. */
  args: readonly string[];
}

/** Sent on the log connection once its nonce is accepted, so the relay opens `data` only after the log is registered. */
export const LOG_ACK = "ok\n";
const MAX_HEADER_BYTES = 64 * 1024;
const HEADER_TIMEOUT_MS = 5_000;
/** A registered log connection whose data connection never comes is dropped. */
const LOG_WAIT_MS = 10_000;

export interface BrokerOptions {
  start: StartProcess;
  /** The program that runs inside the sandbox (pi-env's daemon). */
  command: string;
}

export interface Broker {
  /** Fresh 0700 directory that holds the socket. */
  readonly dir: string;
  readonly socketPath: string;
  /** Resolves when the socket accepts connections. */
  readonly ready: Promise<void>;
  /**
   * A one-use nonce for the next relay. Issuing a new one voids the previous: an env has one relay at a time.
   * The nonce travels in the relay's argv, which is why it is per spawn and the socket dir is 0700.
   */
  issueNonce(): string;
  /** Stops the server, destroys every connection and removes the socket dir. Synchronous and idempotent. */
  close(): void;
}

function sameNonce(given: string, expected: string | undefined): boolean {
  if (expected === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseHeader(line: string): RelayHeader {
  const value = JSON.parse(line) as Partial<RelayHeader> | null;
  if (value === null || typeof value !== "object") throw new Error("header is not an object");
  const { nonce, role, args } = value;
  if (typeof nonce !== "string" || (role !== "log" && role !== "data"))
    throw new Error("bad header");
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    throw new Error("bad args");
  return { nonce, role, args };
}

/** Reads up to the first newline; whatever follows stays in the socket for the byte stream. Leaves the socket paused. */
function readHeader(socket: Socket): Promise<RelayHeader> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const finish = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    const onClose = (): void => {
      finish();
      reject(new Error("closed before the header"));
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end < 0) {
        if (buffered.length > MAX_HEADER_BYTES) {
          finish();
          reject(new Error("header too long"));
        }
        return;
      }
      finish();
      socket.pause();
      const rest = buffered.subarray(end + 1);
      if (rest.length > 0) socket.unshift(rest);
      try {
        resolve(parseHeader(buffered.subarray(0, end).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("header timeout"));
    }, HEADER_TIMEOUT_MS);
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

/**
 * The orchestrator-side half of one sandbox env's bridge. The relay (relay.ts, a process pi-env's Connection spawns)
 * connects here and gets the same service the bridge process used to give: `runBridge` over the socket, with the
 * sandboxd token held in this process. One data connection is served at a time; a new one first ends the previous.
 * Every connection is wrapped so a failure destroys only its own sockets, never the orchestrator or another env.
 */
export function startBroker(options: BrokerOptions): Broker {
  const dir = mkdtempSync(join(tmpdir(), "pi-broker-"));
  const socketPath = join(dir, "b.sock");
  const sockets = new Set<Socket>();
  const logs = new Map<string, Socket>();
  let issued: string | undefined;
  let closed = false;
  let active: AbortController | undefined;
  let chain: Promise<void> = Promise.resolve();

  const track = (socket: Socket): void => {
    sockets.add(socket);
    // Errors (reset by a killed relay, write after end) are expected; the close handlers do the cleanup.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };

  const serve = async (data: Socket, log: Socket, args: readonly string[]): Promise<void> => {
    if (closed || data.destroyed || log.destroyed) {
      data.destroy();
      log.destroy();
      return;
    }
    const mine = new AbortController();
    active = mine;
    data.once("close", () => mine.abort());
    log.once("close", () => mine.abort());
    try {
      await runBridge({
        start: options.start,
        command: options.command,
        args,
        stdin: data,
        stdout: data,
        stderr: log,
        signal: mine.signal,
      });
    } catch (error) {
      log.write(`bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (active === mine) active = undefined;
      // Log first: the relay exits when the data stream ends, and must have read the last log line by then.
      log.end();
      data.end();
      setTimeout(() => {
        log.destroy();
        data.destroy();
      }, 2_000).unref();
    }
  };

  const handle = async (socket: Socket): Promise<void> => {
    const header = await readHeader(socket);
    if (closed || !sameNonce(header.nonce, issued)) throw new Error("bad nonce");
    if (header.role === "log") {
      logs.get(header.nonce)?.destroy();
      logs.set(header.nonce, socket);
      socket.once("close", () => {
        if (logs.get(header.nonce) === socket) logs.delete(header.nonce);
      });
      setTimeout(() => {
        if (logs.get(header.nonce) === socket) socket.destroy();
      }, LOG_WAIT_MS).unref();
      socket.resume(); // the relay sends nothing more; read so a close is seen
      socket.write(LOG_ACK);
      return;
    }
    const log = logs.get(header.nonce);
    if (log === undefined || header.args[0] !== "serve")
      throw new Error("no log connection or not serve");
    logs.delete(header.nonce);
    issued = undefined;
    // One active connection per env: end the previous one and wait for its task before this one starts.
    active?.abort();
    chain = chain.then(() => serve(socket, log, header.args)).catch(() => undefined);
  };

  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    track(socket);
    handle(socket).catch(() => socket.destroy());
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      // After startup an error on the server itself must not escape as an uncaught exception.
      server.on("error", () => undefined);
      resolve();
    });
  });
  // A caller that never awaits `ready` must not see an unhandled rejection; awaiting it still rejects.
  ready.catch(() => undefined);

  return {
    dir,
    socketPath,
    ready,
    issueNonce: () => {
      issued = randomBytes(24).toString("hex");
      return issued;
    },
    close: () => {
      if (closed) return;
      closed = true;
      issued = undefined;
      active?.abort();
      server.close();
      for (const socket of sockets) socket.destroy();
      logs.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
