import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redacted } from "../src/onecli.ts";
import { buildShellEnv, prepareWorkspace, WorkspaceLostError } from "../src/workspace.ts";

const TOKEN = "aoc_0123456789abcdef";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

describe("buildShellEnv", () => {
  const env = buildShellEnv({ gateway: "http://onecli.onecli:10255", token: new Redacted(TOKEN) });

  it("routes HTTPS through the gateway with the agent token as the proxy password", () => {
    expect(env.HTTPS_PROXY).toBe(`http://x:${TOKEN}@onecli.onecli:10255`);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
  });

  it("trusts the OneCLI CA for git, OpenSSL clients and Node, and makes git send proxy basic auth", () => {
    expect(env.SSL_CERT_FILE).toBe("/workspace/.onecli/bundle.pem");
    expect(env.GIT_SSL_CAINFO).toBe("/workspace/.onecli/bundle.pem");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/workspace/.onecli/ca.pem");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.proxyAuthMethod");
    expect(env.GIT_CONFIG_VALUE_0).toBe("basic");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("holds no GitHub token and no orchestrator secret", () => {
    const all = JSON.stringify(env);
    expect(all).not.toMatch(/ghs_|PRIVATE KEY|oc_admin|postgres/);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });
});

describe("prepareWorkspace against a fake proxy", () => {
  let dir: string;
  let root: string;
  let served: string;
  let proxy: Server;
  let proxyUrl: string;
  let seen: { url: string; auth: string | undefined }[];
  let env: NodeExecutionEnv;

  const ca = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n";
  const run = (over: { wasReady?: boolean; branch?: string } = {}) =>
    prepareWorkspace(
      env,
      { repo: "octo/hello", ...(over.branch === undefined ? {} : { branch: over.branch }) },
      {
        ca,
        sessionId: "s-1",
        wasReady: over.wasReady ?? false,
        root,
        gitBase: "http://git.example.test",
      },
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-"));
    root = join(dir, "workspace");
    served = join(dir, "served");
    await mkdir(root, { recursive: true });
    // A repository with a branch `dev`, served as a bare repo over the dumb HTTP protocol.
    const work = join(dir, "work");
    await mkdir(work);
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "t@example.test");
    git(work, "config", "user.name", "t");
    await writeFile(join(work, "README.md"), "hello\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "first");
    git(work, "branch", "dev");
    await mkdir(join(served, "octo"), { recursive: true });
    git(dir, "clone", "-q", "--bare", work, join(served, "octo", "hello.git"));
    git(join(served, "octo", "hello.git"), "update-server-info");

    seen = [];
    proxy = createServer((req, res) => {
      const auth = req.headers["proxy-authorization"];
      seen.push({ url: req.url ?? "", auth });
      if (auth !== `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`) {
        res.writeHead(407, { "proxy-authenticate": 'Basic realm="onecli"' });
        res.end();
        return;
      }
      const file = join(served, new URL(req.url ?? "/", "http://x").pathname);
      if (!file.startsWith(served) || !existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;
    // The session's env, as pi-env's shellEnv would carry it; plain-http proxy so no TLS is needed here.
    const shellEnv = {
      ...buildShellEnv({ gateway: proxyUrl, token: new Redacted(TOKEN) }),
      http_proxy: `http://x:${TOKEN}@${proxyUrl.slice("http://".length)}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    env = new NodeExecutionEnv({ cwd: root, shellEnv });
  });

  afterEach(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("clones through the proxy with the session's token, then writes the marker and the CA bundle", async () => {
    expect(await run()).toBe("cloned");
    expect(await readFile(join(root, "repo", "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(root, ".clone-tmp"))).toBe(false);
    const marker = JSON.parse(await readFile(join(root, ".pi-workspace.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({ version: 1, sessionId: "s-1", repo: "octo/hello" });
    expect(await readFile(join(root, ".onecli", "ca.pem"), "utf8")).toBe(ca);
    expect(await readFile(join(root, ".onecli", "bundle.pem"), "utf8")).toContain("FAKE");
    // Every request carried the proxy credentials at once (proxyAuthMethod=basic): no 407 round trip.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.auth !== undefined)).toBe(true);
    // No credential ended up in the repository's config.
    expect(git(join(root, "repo"), "config", "remote.origin.url")).toBe(
      "http://git.example.test/octo/hello.git\n",
    );
  });

  it("is idempotent: a second call finds the clone and makes no request", async () => {
    await run();
    const requests = seen.length;
    expect(await run({ wasReady: true })).toBe("present");
    expect(seen.length).toBe(requests);
  });

  it("clones the requested branch", async () => {
    await run({ branch: "dev" });
    expect(git(join(root, "repo"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev\n");
  });

  it("replaces a half-finished clone left by a crash", async () => {
    await mkdir(join(root, ".clone-tmp", "junk"), { recursive: true });
    expect(await run()).toBe("cloned");
    expect(existsSync(join(root, "repo", ".git"))).toBe(true);
    expect(existsSync(join(root, ".clone-tmp"))).toBe(false);
  });

  it("does not clone again when the session was ready but the workspace is gone", async () => {
    await expect(run({ wasReady: true })).rejects.toBeInstanceOf(WorkspaceLostError);
    expect(seen).toEqual([]);
    expect(existsSync(join(root, "repo"))).toBe(false);
  });

  it("leaves nothing behind when the clone fails", async () => {
    const wrong = new NodeExecutionEnv({
      cwd: root,
      shellEnv: {
        http_proxy: proxyUrl,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    await expect(
      prepareWorkspace(
        wrong,
        { repo: "octo/hello" },
        { ca, sessionId: "s-1", wasReady: false, root, gitBase: "http://git.example.test" },
      ),
    ).rejects.toThrow(/git clone failed/);
    expect(existsSync(join(root, "repo"))).toBe(false);
    expect(existsSync(join(root, ".clone-tmp"))).toBe(false);
    expect(existsSync(join(root, ".pi-workspace.json"))).toBe(false);
  });
});
