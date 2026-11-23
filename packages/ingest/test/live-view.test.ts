import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { connect as tcpConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { SettingsCache, seedSettings, websocketAccept } from "@cela/session-core";
import type { Settings } from "@cela/session-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseLiveViewPublicUrl } from "../src/config.ts";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

// The public live view on the session API and the anonymous viewer routes (issue #418, ADR 0066).

const seed: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  tokenBudget: null,
  repoAllowlist: ["o/r"],
};
const PUBLIC = "https://live.example.lan";
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

const closers: (() => void)[] = [];
let dir = "";
let cache: SettingsCache | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "live-view-"));
  mkdirSync(join(dir, "novnc", "core"), { recursive: true });
  writeFileSync(join(dir, "viewer.html"), "<!doctype html><title>Live view</title>");
  writeFileSync(join(dir, "viewer.js"), "export {};");
  writeFileSync(join(dir, "novnc", "core", "rfb.js"), "export default class RFB {}");
});
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await cache?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function listen(server: Server): Promise<number> {
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

type FakeOrchestrator = "ok" | "not-101" | "full" | "wrong-accept";

/** An orchestrator stand-in: records what ingest sent and answers as told. */
async function startOrchestrator(mode: FakeOrchestrator = "ok") {
  const seen: { url: string; token: unknown; authorization: unknown }[] = [];
  const server = createServer();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    seen.push({
      url: req.url ?? "",
      token: req.headers["x-live-view-token"],
      authorization: req.headers.authorization,
    });
    socket.on("error", () => undefined);
    if (mode === "not-101") {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\npwnd");
      return;
    }
    if (mode === "full") {
      socket.end("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const key = String(req.headers["sec-websocket-key"]);
    const accept = mode === "ok" ? websocketAccept(key) : "bogus";
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${String(port)}`, seen };
}

async function start(
  options: { enabled?: boolean; orchestratorUrl?: string; desktop?: boolean } = {},
) {
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), seed);
  cache = new SettingsCache(db.asPool(), { pollMs: 60_000 });
  await cache.start();
  const enabled = options.enabled ?? true;
  const server = createIngestServer({
    pool: db.asPool(),
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: options.orchestratorUrl ?? "http://127.0.0.1:1",
    settings: cache,
    admins: ["alice"],
    schemaReady: () => true,
    desktopFlavourEnabled: options.desktop ?? true,
    ...(enabled ? { liveViewPublicUrl: PUBLIC, liveViewDir: dir } : {}),
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${String(port)}`;
  const call = (who: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await call("alice", "PUT", "/admin/profiles/desk", { definition: { sandboxFlavour: "desktop" } });
  return { base, db, port, call };
}

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const tokenOf = (url: unknown): string => String(url).slice(`${PUBLIC}/live/`.length);

/** A WebSocket upgrade by hand; resolves with the 101 socket or the refusal's status and body. */
function upgrade(port: number, path: string) {
  return new Promise<{ status: number; socket?: Duplex; body?: string }>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": KEY,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("live view configuration", () => {
  it("takes an origin only", () => {
    expect(parseLiveViewPublicUrl(undefined)).toBeUndefined();
    expect(parseLiveViewPublicUrl("  ")).toBeUndefined();
    expect(parseLiveViewPublicUrl("https://live.example.lan/")).toBe("https://live.example.lan");
    expect(parseLiveViewPublicUrl("http://10.0.0.5:8443")).toBe("http://10.0.0.5:8443");
    for (const bad of [
      "live.example.lan",
      "ftp://x",
      "https://x/live",
      "https://x?a=1",
      "https://u:p@x",
    ]) {
      expect(() => parseLiveViewPublicUrl(bad), bad).toThrow(/PI_LIVE_VIEW_PUBLIC_URL/);
    }
  });

  it("needs the directory with the URL", () => {
    const env = {
      PI_DURABLE_DATABASE_URL: "postgres://x",
      PI_API_TOKENS: "a:b",
      PI_ORCH_URL: "http://o:8081",
    };
    expect(loadConfig(env).liveViewPublicUrl).toBeUndefined();
    expect(() => loadConfig({ ...env, PI_LIVE_VIEW_PUBLIC_URL: PUBLIC })).toThrow(
      /PI_LIVE_VIEW_DIR/,
    );
    const on = loadConfig({
      ...env,
      PI_LIVE_VIEW_PUBLIC_URL: PUBLIC,
      PI_LIVE_VIEW_DIR: "/app/live-view",
    });
    expect([on.liveViewPublicUrl, on.liveViewDir]).toEqual([PUBLIC, "/app/live-view"]);
  });
});

describe("the live view API", () => {
  it("is refused everywhere while the deployment has it off, and /live is a 404", async () => {
    const { base, call } = await start({ enabled: false });
    const created = await call("bob", "POST", "/sessions", { profile: "desk", liveView: true });
    expect(created.status).toBe(400);
    expect((await json(created)).error).toMatch(/liveView\.enabled/);
    const plain = await json(await call("bob", "POST", "/sessions", { profile: "desk" }));
    const put = await call("bob", "PUT", `/sessions/${String(plain.sessionId)}/live-view`);
    expect(put.status).toBe(400);
    expect((await fetch(`${base}/live/${"A".repeat(43)}`)).status).toBe(404);
    expect((await fetch(`${base}/live/_assets/viewer.js`)).status).toBe(404);
  });

  it("creates a session with a live view, and shows the URL to its owner only", async () => {
    const { call, db } = await start();
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    const url = String(created.liveViewUrl);
    expect(url).toMatch(/^https:\/\/live\.example\.lan\/live\/[A-Za-z0-9_-]{43}$/);
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.live_view_token).toBe(tokenOf(url));
    expect((await json(await call("bob", "GET", `/sessions/${id}`))).liveViewUrl).toBe(url);
    expect((await call("mallory", "GET", `/sessions/${id}`)).status).toBe(404);
    expect((await call("mallory", "PUT", `/sessions/${id}/live-view`)).status).toBe(404);
    expect((await call("mallory", "DELETE", `/sessions/${id}/live-view`)).status).toBe(404);
    expect(db.sessions.get(id)?.live_view_token).toBe(tokenOf(url));
  });

  it("has no liveViewUrl unless it was turned on", async () => {
    const { call, db } = await start();
    const created = await json(await call("bob", "POST", "/sessions", { profile: "desk" }));
    expect(created).not.toHaveProperty("liveViewUrl");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.live_view_token).toBeNull();
    expect(await json(await call("bob", "GET", `/sessions/${id}`))).not.toHaveProperty(
      "liveViewUrl",
    );
    const off = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: false }),
    );
    expect(off).not.toHaveProperty("liveViewUrl");
  });

  it("refuses liveView for another flavour, a non-boolean and a session that is not a desktop", async () => {
    const { call } = await start();
    const plain = await call("bob", "POST", "/sessions", { liveView: true });
    expect(plain.status).toBe(400);
    expect((await json(plain)).error).toMatch(/desktop/);
    expect(
      (await call("bob", "POST", "/sessions", { profile: "desk", liveView: "yes" })).status,
    ).toBe(400);
    const other = await json(await call("bob", "POST", "/sessions", {}));
    expect(
      (await call("bob", "PUT", `/sessions/${String(other.sessionId)}/live-view`)).status,
    ).toBe(400);
  });

  it("PUT enables and rotates; DELETE turns it off, repeatedly", async () => {
    const { call, db } = await start();
    const created = await json(await call("bob", "POST", "/sessions", { profile: "desk" }));
    const id = String(created.sessionId);
    const first = await json(await call("bob", "PUT", `/sessions/${id}/live-view`));
    const second = await json(await call("bob", "PUT", `/sessions/${id}/live-view`));
    expect(first.liveViewUrl).not.toBe(second.liveViewUrl);
    expect(db.sessions.get(id)?.live_view_token).toBe(tokenOf(second.liveViewUrl));
    expect((await call("bob", "DELETE", `/sessions/${id}/live-view`)).status).toBe(204);
    expect((await call("bob", "DELETE", `/sessions/${id}/live-view`)).status).toBe(204);
    expect(db.sessions.get(id)?.live_view_token).toBeNull();
    expect(await json(await call("bob", "GET", `/sessions/${id}`))).not.toHaveProperty(
      "liveViewUrl",
    );
  });

  it("answers 409 for a session that is not active and 410 for a deleted one", async () => {
    const { call, db } = await start();
    const created = await json(await call("bob", "POST", "/sessions", { profile: "desk" }));
    const id = String(created.sessionId);
    const row = db.sessions.get(id);
    if (row === undefined) throw new Error("no row");
    row.status = "failed";
    expect((await call("bob", "PUT", `/sessions/${id}/live-view`)).status).toBe(409);
    row.status = "deleted";
    expect((await call("bob", "PUT", `/sessions/${id}/live-view`)).status).toBe(410);
    expect(row.live_view_token).toBeNull();
  });
});

describe("the viewer routes", () => {
  it("serves the page without a bearer, with headers that keep the token private", async () => {
    const { base, call } = await start();
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    const page = await fetch(String(created.liveViewUrl).replace(PUBLIC, base));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Live view");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("answers an unknown, a rotated and a deleted token with the same 404", async () => {
    const { base, call, db } = await start();
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    const id = String(created.sessionId);
    const old = String(created.liveViewUrl).replace(PUBLIC, base);
    const unknown = await fetch(`${base}/live/${"A".repeat(43)}`);
    expect(unknown.status).toBe(404);
    const body = await unknown.text();
    await call("bob", "PUT", `/sessions/${id}/live-view`);
    const rotated = await fetch(old);
    expect([rotated.status, await rotated.text()]).toEqual([404, body]);
    const row = db.sessions.get(id);
    if (row === undefined) throw new Error("no row");
    const current = `${base}/live/${String(row.live_view_token)}`;
    expect((await fetch(current)).status).toBe(200);
    row.status = "deleting";
    const deleting = await fetch(current);
    expect([deleting.status, await deleting.text()]).toEqual([404, body]);
    expect((await fetch(`${base}/live/not-a-token`)).status).toBe(404);
  });

  it("serves the viewer's script and the noVNC modules, and nothing outside the directory", async () => {
    const { base, port } = await start();
    const script = await fetch(`${base}/live/_assets/viewer.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/live/_assets/novnc/core/rfb.js`)).status).toBe(200);
    expect((await fetch(`${base}/live/_assets/missing.js`)).status).toBe(404);
    // An encoded slash is not a path separator to the URL parser, so only the file lookup can refuse it.
    const traversal = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/live/_assets/..%2f..%2fetc%2fpasswd" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(traversal).toBe(404);
    expect((await fetch(`${base}/live/_assets/viewer.js`, { method: "POST" })).status).toBe(404);
  });
});

describe("the viewer WebSocket", () => {
  it("relays to the owning shard with the token, no bearer and the session id, and back", async () => {
    const orchestrator = await startOrchestrator();
    const { call, port } = await start({ orchestratorUrl: orchestrator.url });
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    const token = tokenOf(created.liveViewUrl);
    const out = await upgrade(port, `/live/${token}/ws`);
    expect(out.status).toBe(101);
    const echoed = new Promise<Buffer>((resolve) => out.socket?.once("data", resolve));
    out.socket?.write("ping-bytes");
    expect((await echoed).toString()).toBe("ping-bytes");
    out.socket?.destroy();
    expect(orchestrator.seen).toEqual([
      { url: `/live-view/${String(created.sessionId)}`, token, authorization: undefined },
    ]);
  });

  it("answers 404 for a token that opens nothing, without asking the orchestrator", async () => {
    const orchestrator = await startOrchestrator();
    const { port } = await start({ orchestratorUrl: orchestrator.url });
    const out = await upgrade(port, `/live/${"A".repeat(43)}/ws`);
    expect(out.status).toBe(404);
    expect(orchestrator.seen).toEqual([]);
  });

  it("keeps a full desktop's 429, and replaces anything else the shard says with a bare 502", async () => {
    for (const [mode, status] of [
      ["full", 429],
      ["not-101", 502],
      ["wrong-accept", 502],
    ] as const) {
      const orchestrator = await startOrchestrator(mode);
      const { call, port } = await start({ orchestratorUrl: orchestrator.url });
      const created = await json(
        await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
      );
      const out = await upgrade(port, `/live/${tokenOf(created.liveViewUrl)}/ws`);
      expect(out.status, mode).toBe(status);
      expect(out.body ?? "", mode).not.toContain("pwnd");
    }
  });

  it("answers 503 when the shard cannot be reached", async () => {
    const { call, port } = await start({ orchestratorUrl: "http://127.0.0.1:1" });
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    expect((await upgrade(port, `/live/${tokenOf(created.liveViewUrl)}/ws`)).status).toBe(503);
  });

  it("survives a viewer that resets while its token is being looked up, and keeps serving", async () => {
    const orchestrator = await startOrchestrator();
    const { call, port, db } = await start({ orchestratorUrl: orchestrator.url });
    const created = await json(
      await call("bob", "POST", "/sessions", { profile: "desk", liveView: true }),
    );
    const token = tokenOf(created.liveViewUrl);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const query = db.query.bind(db);
    db.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes("where live_view_token")) await gate;
      return query(sql, params);
    };
    const socket = tcpConnect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET /live/${token}/ws HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: ${KEY}\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 50));
    socket.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));
    // An unhandled socket error would have ended this process.
    expect((await upgrade(port, `/live/${token}/ws`)).status).toBe(101);
  });

  it("drops every other upgrade", async () => {
    const { port } = await start();
    await expect(upgrade(port, "/sessions/x/stream")).rejects.toThrow();
    await expect(upgrade(port, `/live/${"A".repeat(43)}`)).rejects.toThrow();
    const off = await start({ enabled: false });
    await expect(upgrade(off.port, `/live/${"A".repeat(43)}/ws`)).rejects.toThrow();
  });
});
