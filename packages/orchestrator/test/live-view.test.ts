import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { connect as tcpConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { websocketAccept } from "@cela/session-core";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createOrchestratorServer } from "../src/http.ts";
import { LiveViewProxy } from "../src/live-view.ts";
import { encodeClientFrame } from "../src/rfb-filter.ts";
import type { Host } from "../src/host.ts";
import type { SessionService } from "../src/sessions.ts";

// The orchestrator's end of the public live view (ADR 0066) against a fake websockify on an ephemeral port.

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "A".repeat(43);
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

interface Row {
  id: string;
  owner: string;
  owner_subject: string;
  status: string;
  shard: number;
  conversation_id: string | null;
  live_view_token: string | null;
  created_at: Date;
  last_activity_at: Date;
}

const baseRow = (): Row => ({
  id: SESSION,
  owner: "alice",
  owner_subject: "static:alice",
  status: "active",
  shard: 0,
  conversation_id: "7",
  live_view_token: TOKEN,
  created_at: new Date(),
  last_activity_at: new Date(),
});

interface Pod {
  server: Server;
  port: number;
  /** What the Pod's websockify received after the handshake, as unmasked bytes of binary frames. */
  received: Buffer[];
  sockets: Duplex[];
}

const open: { close(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.close();
});

async function listen(server: Server): Promise<number> {
  open.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A websockify that answers the handshake (or misbehaves as told) and records the client frames it gets. */
async function startPod(
  mode: "ok" | "wrong-accept" | "not-101" = "ok",
  readDelayMs = 0,
): Promise<Pod> {
  const received: Buffer[] = [];
  const sockets: Duplex[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("I am the pod");
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    if (mode === "not-101") {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\npwnd");
      return;
    }
    sockets.push(socket);
    const key = String(req.headers["sec-websocket-key"]);
    const accept = mode === "ok" ? websocketAccept(key) : "bogus";
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\nsec-websocket-protocol: binary\r\nx-pod-header: evil\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { payload, used } = unmaskComplete(pending);
      received.push(payload);
      pending = pending.subarray(used);
    });
    if (readDelayMs > 0) {
      socket.pause();
      setTimeout(() => socket.resume(), readDelayMs).unref();
    }
    socket.on("error", () => undefined);
  });
  return { server, port: await listen(server), received, sockets };
}

/** The payloads of the complete masked frames at the start of `wire`, and how many bytes they used. */
function unmaskComplete(wire: Buffer): { payload: Buffer; used: number } {
  const parts: Buffer[] = [];
  let at = 0;
  while (wire.length - at >= 2) {
    let length = (wire[at + 1] ?? 0) & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (wire.length - at < 4) break;
      length = wire.readUInt16BE(offset);
      offset += 2;
    }
    if (wire.length < offset + 4 + length) break;
    const mask = wire.subarray(offset, offset + 4);
    parts.push(
      Buffer.from(
        wire.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ (mask[i % 4] ?? 0)),
      ),
    );
    at = offset + 4 + length;
  }
  return { payload: Buffer.concat(parts), used: at };
}

interface Harness {
  base: string;
  row: Row;
  proxy: LiveViewProxy;
  ensured: { count: number };
  podLookups: string[];
}

async function start(
  pod: Pod | undefined,
  options: {
    maxPerSession?: number;
    maxPerShard?: number;
    podIp?: string | undefined;
    idleMs?: number;
    /** Holds every database read until it resolves. */
    dbGate?: Promise<void>;
    /** Holds every Pod address lookup until it resolves. */
    podGate?: Promise<void>;
  } = {},
): Promise<Harness> {
  const row = baseRow();
  const pool = {
    query: async () => {
      await options.dbGate;
      return { rows: [{ ...row }] };
    },
  } as unknown as pg.Pool;
  const podLookups: string[] = [];
  const proxy = new LiveViewProxy({
    pool,
    shard: 0,
    podIp: async (claim) => {
      podLookups.push(claim);
      await options.podGate;
      return "podIp" in options ? options.podIp : "127.0.0.1";
    },
    maxPerSession: options.maxPerSession ?? 4,
    maxPerShard: options.maxPerShard ?? 32,
    recheckMs: 60_000,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(pod === undefined ? {} : { podPort: pod.port }),
  });
  open.push({ close: () => proxy.close() });
  const ensured = { count: 0 };
  const server = createOrchestratorServer({
    lifecycle: {
      state: "owner",
      instance: "t",
      host: {} as Host,
      service: {
        ensureConversation: () => {
          ensured.count += 1;
          return Promise.resolve(1);
        },
      } as unknown as SessionService,
    },
    authenticate: () => Promise.reject(new Error("the viewer route has no bearer")),
    pool,
    shard: 0,
    control: false,
    liveView: proxy,
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${String(port)}`, row, proxy, ensured, podLookups };
}

type Outcome = {
  status: number;
  socket?: Duplex;
  head?: Buffer;
  headers?: Record<string, unknown>;
  body?: string;
};

function connect(
  h: Harness,
  path = `/live-view/${SESSION}`,
  token: string | null = TOKEN,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${h.base}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": KEY,
        "sec-websocket-protocol": "binary",
        ...(token === null ? {} : { "x-live-view-token": token }),
      },
    });
    req.on("upgrade", (res, socket, head) => {
      resolve({ status: res.statusCode ?? 0, socket, head, headers: res.headers });
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
const POINTER = Buffer.from([5, 1, 0, 1, 0, 1]);
const FB_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 1, 0, 1, 0]);

describe("LiveViewProxy", () => {
  it("relays the framebuffer raw and the viewer's input only as view-only RFB, without a bearer or a conversation", async () => {
    const pod = await startPod();
    const h = await start(pod);
    const out = await connect(h);
    expect(out.status).toBe(101);
    // Only the whitelisted handshake headers reach the viewer, never the Pod's own.
    expect(out.headers?.["x-pod-header"]).toBeUndefined();
    expect(out.headers?.["sec-websocket-accept"]).toBe(websocketAccept(KEY));
    expect(out.headers?.["sec-websocket-protocol"]).toBe("binary");

    const seen: Buffer[] = [];
    out.socket?.on("data", (c: Buffer) => seen.push(c));
    out.socket?.write(
      encodeClientFrame(
        2,
        Buffer.concat([VERSION, Buffer.from([1, 0]), KEY_EVENT, POINTER, FB_REQUEST]),
      ),
    );
    await waitFor(() => Buffer.concat(pod.received).length >= 12 + 2 + FB_REQUEST.length);
    expect(Buffer.concat(pod.received)).toEqual(
      Buffer.concat([VERSION, Buffer.from([1, 1]), FB_REQUEST]),
    );

    // The Pod's bytes go back unparsed.
    pod.sockets[0]?.write(Buffer.from([0x82, 0x03, 1, 2, 3]));
    await waitFor(() => Buffer.concat(seen).equals(Buffer.from([0x82, 0x03, 1, 2, 3])));
    expect(h.ensured.count).toBe(0);
    expect(h.podLookups).toEqual(["pi-conv-7"]);
  });

  it("closes the connection when the viewer sends a message that is not view-only RFB", async () => {
    const pod = await startPod();
    const h = await start(pod);
    const out = await connect(h);
    let closed = false;
    out.socket?.on("close", () => (closed = true));
    out.socket?.write(
      encodeClientFrame(2, Buffer.concat([VERSION, Buffer.from([1, 1]), Buffer.from([0x7f])])),
    );
    await waitFor(() => closed);
  });

  it("answers an unknown session, a wrong token and a session without a live view alike", async () => {
    const pod = await startPod();
    const h = await start(pod);
    const wrong = await connect(h, `/live-view/${SESSION}`, "B".repeat(43));
    expect(wrong.status).toBe(404);
    const missing = await connect(h, `/live-view/${SESSION}`, null);
    expect(missing.status).toBe(400);
    h.row.live_view_token = null;
    const off = await connect(h);
    expect(off.status).toBe(404);
    expect(off.body).toBe(wrong.body);
    h.row.live_view_token = TOKEN;
    h.row.status = "deleting";
    expect((await connect(h)).status).toBe(404);
    expect(h.podLookups).toEqual([]);
    expect(h.ensured.count).toBe(0);
  });

  it("refuses a session of another shard before looking for a Pod", async () => {
    const h = await start(await startPod());
    h.row.shard = 1;
    expect((await connect(h)).status).toBe(421);
    expect(h.podLookups).toEqual([]);
  });

  it("does not create a conversation or look for a Pod when the session has none", async () => {
    const h = await start(await startPod());
    h.row.conversation_id = null;
    expect((await connect(h)).status).toBe(503);
    expect(h.podLookups).toEqual([]);
    expect(h.ensured.count).toBe(0);
  });

  it("answers 503 while the sandbox has no Pod address, and when the Pod refuses the connection", async () => {
    const noIp = await start(undefined, { podIp: undefined });
    expect((await connect(noIp)).status).toBe(503);
    // A port nobody listens on.
    const closedPort = createServer();
    const port = await listen(closedPort);
    closedPort.close();
    const refused = await start({ port } as Pod);
    expect((await connect(refused)).status).toBe(503);
    await waitFor(() => refused.proxy.viewers === 0);
  });

  it("never forwards what a Pod answers instead of a 101, and rejects a wrong accept", async () => {
    const plain = await start(await startPod("not-101"));
    const out = await connect(plain);
    expect(out.status).toBe(502);
    expect(out.body ?? "").not.toContain("pwnd");
    const forged = await start(await startPod("wrong-accept"));
    expect((await connect(forged)).status).toBe(502);
    await waitFor(() => forged.proxy.viewers === 0);
  });

  it("caps viewers per session and per shard with a 429, and frees the slot when one leaves", async () => {
    const h = await start(await startPod(), { maxPerSession: 2, maxPerShard: 2 });
    const first = await connect(h);
    const second = await connect(h);
    expect([first.status, second.status]).toEqual([101, 101]);
    expect((await connect(h)).status).toBe(429);
    first.socket?.destroy();
    await waitFor(() => h.proxy.viewers === 1);
    expect((await connect(h)).status).toBe(101);
  });

  it("cuts the viewers within a recheck when the live view is turned off or its token replaced", async () => {
    const h = await start(await startPod());
    const first = await connect(h);
    let closed = false;
    first.socket?.on("close", () => (closed = true));
    await h.proxy.recheck();
    expect(closed).toBe(false);
    h.row.live_view_token = "C".repeat(43);
    await h.proxy.recheck();
    await waitFor(() => closed);
    expect(h.proxy.viewers).toBe(0);
    const again = await connect(h, `/live-view/${SESSION}`, "C".repeat(43));
    expect(again.status).toBe(101);
    h.row.live_view_token = null;
    await h.proxy.recheck();
    await waitFor(() => h.proxy.viewers === 0);
  });

  it("cuts the viewers when the session starts deleting", async () => {
    const h = await start(await startPod());
    const out = await connect(h);
    let closed = false;
    out.socket?.on("close", () => (closed = true));
    h.row.status = "deleting";
    await h.proxy.recheck();
    await waitFor(() => closed);
  });

  it("survives a viewer that resets while the session is being looked up, and keeps serving", async () => {
    let release: () => void = () => undefined;
    const dbGate = new Promise<void>((resolve) => (release = resolve));
    const h = await start(await startPod(), { dbGate });
    const port = Number(new URL(h.base).port);
    const socket = tcpConnect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET /live-view/${SESSION} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: ${KEY}\r\nx-live-view-token: ${TOKEN}\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 50));
    socket.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));
    // An unhandled socket error would have ended this process; the proxy must also hold no slot for the dead viewer.
    await waitFor(() => h.proxy.viewers === 0);
    expect((await connect(h)).status).toBe(101);
  });

  it("survives a viewer that resets while the Pod address is being looked up", async () => {
    let release: () => void = () => undefined;
    const podGate = new Promise<void>((resolve) => (release = resolve));
    const h = await start(await startPod(), { podGate });
    const port = Number(new URL(h.base).port);
    const socket = tcpConnect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET /live-view/${SESSION} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: ${KEY}\r\nx-live-view-token: ${TOKEN}\r\n\r\n`,
    );
    await waitFor(() => h.podLookups.length === 1);
    socket.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await waitFor(() => h.proxy.viewers === 0);
    expect(h.podLookups).toHaveLength(1);
  });

  it("never admits more viewers than the caps when a burst arrives together", async () => {
    for (const caps of [
      { maxPerSession: 2, maxPerShard: 32 },
      { maxPerSession: 8, maxPerShard: 3 },
    ]) {
      let release: () => void = () => undefined;
      const podGate = new Promise<void>((resolve) => (release = resolve));
      const h = await start(await startPod(), { ...caps, podGate });
      const attempts = Array.from({ length: 12 }, () => connect(h));
      await new Promise((r) => setTimeout(r, 100));
      expect(h.proxy.viewers).toBeLessThanOrEqual(Math.min(caps.maxPerSession, caps.maxPerShard));
      release();
      const outcomes = await Promise.all(attempts);
      const admitted = outcomes.filter((o) => o.status === 101).length;
      expect(admitted).toBe(Math.min(caps.maxPerSession, caps.maxPerShard));
      expect(outcomes.filter((o) => o.status === 429)).toHaveLength(12 - admitted);
      expect(h.proxy.viewers).toBe(admitted);
    }
  });

  it("gives the slot back when the Pod lookup fails", async () => {
    const h = await start(undefined, { podIp: undefined, maxPerSession: 1 });
    expect((await connect(h)).status).toBe(503);
    expect((await connect(h)).status).toBe(503);
    expect(h.proxy.viewers).toBe(0);
  });

  it("delivers everything a fast viewer sends to a slow Pod", async () => {
    const pod = await startPod("ok", 300);
    const h = await start(pod);
    const out = await connect(h);
    const fbRequest = Buffer.from([3, 1, 0, 0, 0, 0, 1, 0, 1, 0]);
    const chunk = Buffer.concat(Array.from({ length: 6000 }, () => fbRequest));
    const prefix = Buffer.concat([VERSION, Buffer.from([1, 1])]);
    out.socket?.write(encodeClientFrame(2, Buffer.concat([prefix, chunk])));
    for (let i = 1; i < 60; i += 1) out.socket?.write(encodeClientFrame(2, chunk));
    const want = prefix.length + 60 * chunk.length;
    await waitFor(() => Buffer.concat(pod.received).length >= want);
    expect(Buffer.concat(pod.received).length).toBe(want);
  });

  it("drops a viewer that sent nothing for the idle time, whatever the Pod sends", async () => {
    const pod = await startPod();
    const h = await start(pod, { idleMs: 150 });
    const out = await connect(h);
    let closed = false;
    out.socket?.on("close", () => (closed = true));
    out.socket?.on("data", () => undefined);
    const chatter = setInterval(() => pod.sockets[0]?.write(Buffer.from([0x82, 0x01, 1])), 20);
    try {
      await waitFor(() => closed);
    } finally {
      clearInterval(chatter);
    }
    await waitFor(() => h.proxy.viewers === 0);
  });

  it("keeps a viewer that keeps sending", async () => {
    const pod = await startPod();
    const h = await start(pod, { idleMs: 200 });
    const out = await connect(h);
    let closed = false;
    out.socket?.on("close", () => (closed = true));
    const fbRequest = Buffer.from([3, 1, 0, 0, 0, 0, 1, 0, 1, 0]);
    out.socket?.write(encodeClientFrame(2, Buffer.concat([VERSION, Buffer.from([1, 1])])));
    for (let i = 0; i < 12; i += 1) {
      out.socket?.write(encodeClientFrame(2, fbRequest));
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(closed).toBe(false);
  });

  it("drops an upgrade when the live view is not enabled", async () => {
    const server = createOrchestratorServer({
      lifecycle: { state: "owner", instance: "t" },
      authenticate: () => Promise.resolve(undefined),
      pool: {} as pg.Pool,
      shard: 0,
      control: false,
    });
    const port = await listen(server);
    await expect(
      connect({ base: `http://127.0.0.1:${String(port)}` } as Harness),
    ).rejects.toThrow();
  });
});
