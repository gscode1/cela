import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, seedSettings } from "@cela/session-core";
import type { SandboxRuntimes, Settings } from "@cela/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

// Named sandbox runtimes on the session API and the admin API (issue #406).

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

const runtimes: SandboxRuntimes = {
  gvisorkvm: {
    runtimeClassName: "gvisor-kvm",
    insecure: false,
    flavours: ["default", "browser", "desktop"],
  },
  runc: { runtimeClassName: "runc-sandbox", insecure: true, flavours: ["default"] },
};

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

async function start(
  sandboxRuntimes: SandboxRuntimes,
  options: { shared?: FakeSettingsDb; allowDirect?: boolean; browser?: boolean } = {},
) {
  const db = options.shared ?? new FakeSettingsDb();
  await seedSettings(db.asPool(), seed);
  cache = new SettingsCache(db.asPool(), { pollMs: 60_000 });
  await cache.start();
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: "http://unused",
    settings: cache,
    admins: ["alice"],
    schemaReady: () => true,
    sandboxRuntimes,
    allowDirectSandboxEgress: options.allowDirect ?? false,
    browserFlavourEnabled: options.browser ?? true,
    desktopFlavourEnabled: true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, db };
}

const call = (base: string, who: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const put = (base: string, name: string, definition: Record<string, unknown>) =>
  call(base, "alice", "PUT", `/admin/profiles/${name}`, { definition });

describe("sandbox runtimes", () => {
  it("a session is on the default runtime by default, and stores null", async () => {
    const { base, db } = await start(runtimes);
    const created = await json(await call(base, "bob", "POST", "/sessions", {}));
    expect(created.sandboxRuntime).toBe("default");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.sandbox_runtime).toBeNull();
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).sandboxRuntime).toBe(
      "default",
    );
  });

  it("stores the profile's runtime on the session and reports it", async () => {
    const { base, db } = await start(runtimes);
    expect((await put(base, "rc", { sandboxRuntime: "runc" })).status).toBe(201);
    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "rc" }));
    expect(created.sandboxRuntime).toBe("runc");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.sandbox_runtime).toBe("runc");
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).sandboxRuntime).toBe(
      "runc",
    );
  });

  it("accepts a runtime that lists the browser flavour", async () => {
    const { base } = await start(runtimes);
    const written = await put(base, "kvmweb", {
      sandboxRuntime: "gvisorkvm",
      sandboxFlavour: "browser",
    });
    expect(written.status).toBe(201);
  });

  it("accepts a runtime that lists the desktop flavour", async () => {
    const { base } = await start(runtimes);
    const written = await put(base, "kvmdesk", {
      sandboxRuntime: "gvisorkvm",
      sandboxFlavour: "desktop",
    });
    expect(written.status).toBe(201);
  });

  it("POST /sessions never takes the runtime from the body", async () => {
    const { base, db } = await start(runtimes);
    const created = await json(
      await call(base, "bob", "POST", "/sessions", { sandboxRuntime: "runc" }),
    );
    expect(created.sandboxRuntime).toBe("default");
    expect(db.sessions.get(String(created.sessionId))?.sandbox_runtime).toBeNull();
  });

  describe("refuses at profile write", () => {
    it("an unknown runtime, naming sandbox.runtimes", async () => {
      const { base } = await start(runtimes);
      const refused = await put(base, "odd", { sandboxRuntime: "nope" });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(/sandbox\.runtimes/);
    });

    it("any runtime when the deployment has none", async () => {
      const { base } = await start({});
      const refused = await put(base, "rc", { sandboxRuntime: "runc" });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(/has not set sandbox\.runtimes/);
    });

    it("a flavour the runtime does not list", async () => {
      const { base } = await start(runtimes);
      const refused = await put(base, "rcweb", {
        sandboxRuntime: "runc",
        sandboxFlavour: "browser",
      });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(/sandbox\.runtimes\.runc\.flavours/);
    });

    it("direct network mode with a named runtime", async () => {
      const { base } = await start(runtimes, { allowDirect: true });
      const refused = await put(base, "rcdirect", {
        sandboxRuntime: "runc",
        networkMode: "direct",
      });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(
        /networkMode direct cannot be combined with sandboxRuntime/,
      );
    });

    it("a malformed name", async () => {
      const { base } = await start(runtimes);
      const refused = await put(base, "odd", { sandboxRuntime: "Run-C" });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(/sandboxRuntime must be a runtime name/);
    });
  });

  describe("refuses at session create when the environment changed since the write", () => {
    const stored = async (definition: Record<string, unknown>, after: SandboxRuntimes) => {
      const first = await start(runtimes, { allowDirect: true });
      expect((await put(first.base, "p", definition)).status).toBe(201);
      const second = await start(after, { shared: first.db, allowDirect: true });
      const refused = await call(second.base, "bob", "POST", "/sessions", { profile: "p" });
      expect(refused.status).toBe(400);
      expect(second.db.sessions.size).toBe(0);
      return String((await json(refused)).error);
    };

    it("the runtime was removed", async () => {
      expect(await stored({ sandboxRuntime: "runc" }, {})).toMatch(/sandbox\.runtimes/);
    });

    it("the runtime no longer lists the flavour", async () => {
      const error = await stored(
        { sandboxRuntime: "gvisorkvm", sandboxFlavour: "browser" },
        { gvisorkvm: { runtimeClassName: "gvisor-kvm", insecure: false, flavours: ["default"] } },
      );
      expect(error).toMatch(/sandbox\.runtimes\.gvisorkvm\.flavours/);
    });

    it("a stored profile combines a runtime with direct (a row from before the rule)", async () => {
      const first = await start(runtimes, { allowDirect: true });
      expect((await put(first.base, "p", { sandboxRuntime: "runc" })).status).toBe(201);
      // Written straight into the fake: the write path would refuse this pair.
      for (const version of first.db.versions) {
        if (version.name === "p")
          version.definition = { sandboxRuntime: "runc", networkMode: "direct" };
      }
      const refused = await call(first.base, "bob", "POST", "/sessions", { profile: "p" });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error).toMatch(
        /networkMode direct cannot be combined with sandboxRuntime/,
      );
      expect(first.db.sessions.size).toBe(0);
    });
  });

  it("lists the runtimes for admins only", async () => {
    const { base } = await start(runtimes);
    expect(await json(await call(base, "alice", "GET", "/admin/sandbox-runtimes"))).toEqual({
      runtimes: [
        { name: "gvisorkvm", flavours: ["default", "browser", "desktop"], insecure: false },
        { name: "runc", flavours: ["default"], insecure: true },
      ],
      defaultRuntime: "default",
    });
    expect((await call(base, "bob", "GET", "/admin/sandbox-runtimes")).status).toBe(403);
    const none = await start({});
    expect(
      (await json(await call(none.base, "alice", "GET", "/admin/sandbox-runtimes"))).runtimes,
    ).toEqual([]);
  });
});
