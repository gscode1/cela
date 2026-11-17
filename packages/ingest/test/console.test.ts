import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";

let server: Server | undefined;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "console-test-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>console</title>");
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  await writeFile(join(dir, "assets", "app.css"), "body{}");
  await writeFile(join(dir, "assets", "font.woff2"), "font");
  await writeFile(join(dir, "favicon.svg"), "<svg/>");
  // Next to the served directory, so a traversal would find it.
  await writeFile(join(dir, "..", "console-secret.txt"), "secret");
});
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await rm(dir, { recursive: true, force: true });
  await rm(join(dir, "..", "console-secret.txt"), { force: true });
});

async function start(consoleDir: string | undefined, ready = true): Promise<string> {
  const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;
  server = createIngestServer({
    pool,
    authenticate: (headers) =>
      Promise.resolve(
        headers.authorization === "Bearer alice"
          ? { owner: "alice", subject: "static:alice" }
          : undefined,
      ),
    orchestratorUrl: "http://unused",
    settings: {} as SettingsView,
    admins: ["alice"],
    consoleDir,
    schemaReady: () => ready,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const headersOf = (res: Response): Record<string, string | null> => ({
  cache: res.headers.get("cache-control"),
  csp: res.headers.get("content-security-policy"),
  nosniff: res.headers.get("x-content-type-options"),
  referrer: res.headers.get("referrer-policy"),
});
const HARDENED = {
  cache: "no-store",
  csp: "default-src 'self'; frame-ancestors 'none'",
  nosniff: "nosniff",
  referrer: "no-referrer",
};

/** fetch normalizes `..` away, so a raw request is the only way to send it. */
function raw(base: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("console serving", () => {
  it("serves index.html at /console/ without a token, even before the schema is ready", async () => {
    const base = await start(dir, false);
    const res = await fetch(`${base}/console/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>console</title>");
    expect(headersOf(res)).toEqual(HARDENED);
  });

  it("redirects /console to /console/", async () => {
    const base = await start(dir);
    const res = await fetch(`${base}/console`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/console/");
  });

  it("serves assets with their content types and the headers", async () => {
    const base = await start(dir);
    const cases: [string, string][] = [
      ["/console/assets/app.js", "text/javascript; charset=utf-8"],
      ["/console/assets/app.css", "text/css; charset=utf-8"],
      ["/console/assets/font.woff2", "font/woff2"],
      ["/console/favicon.svg", "image/svg+xml"],
    ];
    for (const [path, type] of cases) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(headersOf(res), path).toEqual(HARDENED);
    }
  });

  it("answers HEAD without a body and rejects other methods", async () => {
    const base = await start(dir);
    const head = await fetch(`${base}/console/assets/app.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("14");
    expect(await head.text()).toBe("");
    const post = await fetch(`${base}/console/`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("falls back to index.html for routes without an extension only", async () => {
    const base = await start(dir);
    for (const path of ["/console/profiles", "/console/mcp-servers/x/y", "/console/skills/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("<title>console</title>");
    }
    for (const path of [
      "/console/assets/missing.js",
      "/console/nope.png",
      "/console/profiles.json",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect(headersOf(res), path).toEqual(HARDENED);
    }
  });

  it("never serves a file outside the directory", async () => {
    const base = await start(dir);
    const attempts = [
      "/console/../console-secret.txt",
      "/console/%2e%2e/console-secret.txt",
      "/console/..%2fconsole-secret.txt",
      "/console/assets/..%2f..%2fconsole-secret.txt",
      "/console/..%5cconsole-secret.txt",
      "/console/%00.js",
      "/console/%zz.js",
    ];
    for (const path of attempts) {
      const res = await raw(base, path);
      expect(res.body, path).not.toContain("secret");
      expect([301, 308, 400, 401, 404], path).toContain(res.status);
    }
  });

  it("is a 404 for /console and below when no directory is configured", async () => {
    const base = await start(undefined);
    for (const path of ["/console", "/console/", "/console/profiles", "/console/assets/app.js"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(404);
    }
  });

  it("does not turn other paths into console routes", async () => {
    const base = await start(dir);
    expect((await fetch(`${base}/consolex/`)).status).toBe(401);
    expect((await fetch(`${base}/index.html`)).status).toBe(401);
  });
});

describe("the bearer gate and the admin headers", () => {
  it("still covers everything that is not the console", async () => {
    const base = await start(dir);
    for (const [method, path] of [
      ["GET", "/admin/settings"],
      ["GET", "/sessions/abc"],
      ["POST", "/sessions"],
      ["GET", "/"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, path).toBe(401);
    }
  });

  it("puts the headers on admin responses, including 401 and 403", async () => {
    const base = await start(dir);
    const unauthorized = await fetch(`${base}/admin/settings`);
    expect(unauthorized.status).toBe(401);
    expect(headersOf(unauthorized)).toEqual(HARDENED);
    expect(unauthorized.headers.get("content-type")).toBe("application/json");
  });

  it("puts the headers on admin responses when no console is configured", async () => {
    const base = await start(undefined);
    expect(headersOf(await fetch(`${base}/admin/settings`))).toEqual(HARDENED);
  });
});
