import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, parseSandboxSizes, seedSettings } from "@pi-durable-k8s/session-core";
import type { SandboxSizes, Settings } from "@pi-durable-k8s/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

// Sandbox sizes on the session API (issue #108, docs/decisions/0030-sandbox-sizes.md).

const seed: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  tokenBudget: null,
};
const spec = (cpu: string) => ({
  resources: { requests: { cpu }, limits: { cpu, memory: "1Gi" } },
  workspaceSize: "1Gi",
  ephemeralStorage: "1Gi",
  warmPoolReplicas: 0,
});
const SIZES = parseSandboxSizes({
  PI_SANDBOX_SIZES: JSON.stringify({ s: spec("250m"), m: spec("1"), l: spec("2") }),
  PI_SANDBOX_DEFAULT_SIZE: "s",
});

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(sandboxSizes: SandboxSizes | null = SIZES ?? null) {
  const db = new FakeSettingsDb();
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
    sandboxSizes: sandboxSizes ?? undefined,
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

describe("sandbox sizes", () => {
  it("gives a new session the deployment default, stores it and reports it", async () => {
    const { base, db } = await start();
    const created = await call(base, "bob", "POST", "/sessions", {});
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.sandboxSize).toBe("s");
    const id = String(body.sessionId);
    expect(db.sessions.get(id)?.sandbox_size).toBe("s");
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).sandboxSize).toBe("s");
  });

  it("takes the profile's size, and lets a caller pick only what the profile allows", async () => {
    const { base } = await start();
    const put = await call(base, "alice", "PUT", "/admin/profiles/build", {
      definition: { sandboxSize: "m", sandboxSizes: ["l"] },
    });
    expect(put.status).toBe(201);
    const byProfile = await json(
      await call(base, "bob", "POST", "/sessions", { profile: "build" }),
    );
    expect(byProfile.sandboxSize).toBe("m");
    const picked = await json(
      await call(base, "bob", "POST", "/sessions", { profile: "build", sandboxSize: "l" }),
    );
    expect(picked.sandboxSize).toBe("l");
    const refused = await call(base, "bob", "POST", "/sessions", {
      profile: "build",
      sandboxSize: "s",
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toBe(
      'sandboxSize "s" is not allowed by the profile (allowed: l, m)',
    );
    // The default profile allows nothing but the default.
    const plain = await call(base, "bob", "POST", "/sessions", { sandboxSize: "l" });
    expect(plain.status).toBe(400);
  });

  it("refuses a profile version that names a size the deployment does not define", async () => {
    const { base } = await start();
    const put = await call(base, "alice", "PUT", "/admin/profiles/huge", {
      definition: { sandboxSize: "xl" },
    });
    expect(put.status).toBe(400);
    expect((await json(put)).error).toBe('sandbox size "xl" is not defined (defined: l, m, s)');
  });

  it("lists the sizes for admins only", async () => {
    const { base } = await start();
    const listed = await json(await call(base, "alice", "GET", "/admin/sandbox-sizes"));
    expect(listed.defaultSize).toBe("s");
    expect((listed.sizes as { name: string }[]).map((size) => size.name)).toEqual(["l", "m", "s"]);
    expect((await call(base, "bob", "GET", "/admin/sandbox-sizes")).status).toBe(403);
  });

  it("without sizes: no size on the session, and asking for one is a 400", async () => {
    const { base, db } = await start(null);
    const body = await json(await call(base, "bob", "POST", "/sessions", {}));
    expect(body.sandboxSize).toBeUndefined();
    expect(db.sessions.get(String(body.sessionId))?.sandbox_size).toBeNull();
    const asked = await call(base, "bob", "POST", "/sessions", { sandboxSize: "s" });
    expect(asked.status).toBe(400);
    expect(await json(await call(base, "alice", "GET", "/admin/sandbox-sizes"))).toEqual({
      sizes: [],
      defaultSize: null,
    });
  });
});
