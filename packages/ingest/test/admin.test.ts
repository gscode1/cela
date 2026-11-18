import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, seedSettings } from "@pi-durable-k8s/session-core";
import type { Settings } from "@pi-durable-k8s/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

const seed: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
};

/** What the fake shard 0 row says to a probe request; reset by every `start`. */
const probe = { running: false, shardExists: true, requests: 0 };

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(
  admins: string[] = ["alice"],
): Promise<{ base: string; db: FakeSettingsDb; sessions: unknown[][] }> {
  Object.assign(probe, { running: false, shardExists: true, requests: 0 });
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), seed);
  const sessions: unknown[][] = [];
  const query = db.query.bind(db);
  db.query = (sql, params) => {
    if (sql.includes("probe_requested_at = clock_timestamp()")) {
      probe.requests++;
      return Promise.resolve({ rows: [], rowCount: probe.running || !probe.shardExists ? 0 : 1 });
    }
    if (sql.startsWith("select 1 from inbox.shard_status"))
      return Promise.resolve({ rows: [], rowCount: probe.shardExists ? 1 : 0 });
    if (sql.includes("from inbox.shard_status"))
      return Promise.resolve({
        rows: [
          {
            shard: 0,
            configuredRuntime: "gvisor",
            observedRuntime: null,
            networkPolicy: "unknown",
            networkPolicyCheckedAt: null,
            networkPolicyDetail: null,
            updatedAt: new Date(0),
          },
        ],
        rowCount: 1,
      });
    if (sql.startsWith("insert into inbox.sessions")) {
      sessions.push(params ?? []);
      // The insert returns the id it stored (store.ts createSession).
      return Promise.resolve({ rows: [{ id: params?.[0] }], rowCount: 1 });
    }
    return query(sql, params);
  };
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
    admins,
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    db,
    sessions,
  };
}

const call = (
  base: string,
  who: string | undefined,
  method: string,
  path: string,
  body?: unknown,
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(who === undefined ? {} : { authorization: `Bearer ${who}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("admin settings authorization", () => {
  it("answers 401 without a token, 403 to a non-admin and 200 to an admin, on every route", async () => {
    const { base } = await start();
    const routes: [string, string, unknown?][] = [
      ["GET", "/admin/status"],
      ["GET", "/admin/settings"],
      ["PUT", "/admin/settings", { turnBudget: 5 }],
      ["GET", "/admin/settings/history"],
    ];
    for (const [method, path, body] of routes) {
      expect(
        (await call(base, undefined, method, path, body)).status,
        `${method} ${path} anon`,
      ).toBe(401);
      expect((await call(base, "bob", method, path, body)).status, `${method} ${path} bob`).toBe(
        403,
      );
      expect(
        (await call(base, "alice", method, path, body)).status,
        `${method} ${path} alice`,
      ).toBe(200);
    }
  });

  it("makes nobody an admin when the list is empty", async () => {
    const { base } = await start([]);
    expect((await call(base, "alice", "GET", "/admin/settings")).status).toBe(403);
  });
});

describe("admin status and the isolation probe", () => {
  it("GET shows the namespace's isolation state next to the shards", async () => {
    const { base } = await start();
    const got = (await (await call(base, "alice", "GET", "/admin/status")).json()) as Record<
      string,
      unknown
    >;
    expect(got).toMatchObject({
      shards: [{ shard: 0, networkPolicy: "unknown" }],
      networkPolicy: { state: "unknown", checkedAt: null, detail: null },
    });
  });

  it("POST /admin/status/probe is for admins only", async () => {
    const { base } = await start();
    expect((await call(base, undefined, "POST", "/admin/status/probe")).status).toBe(401);
    expect((await call(base, "bob", "POST", "/admin/status/probe")).status).toBe(403);
    expect(probe.requests).toBe(0);
  });

  it("POST /admin/status/probe records a request for shard 0 and answers 202", async () => {
    const { base } = await start();
    const res = await call(base, "alice", "POST", "/admin/status/probe");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requested: true, state: "requested" });
    expect(probe.requests).toBe(1);
  });

  it("answers 202 without a second request while a run is in progress, and 503 before shard 0 reported", async () => {
    const { base } = await start();
    probe.running = true;
    const running = await call(base, "alice", "POST", "/admin/status/probe");
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({ requested: false, state: "running" });
    probe.running = false;
    probe.shardExists = false;
    expect((await call(base, "alice", "POST", "/admin/status/probe")).status).toBe(503);
  });

  it("rejects other methods on both routes", async () => {
    const { base } = await start();
    expect((await call(base, "alice", "GET", "/admin/status/probe")).status).toBe(405);
    expect((await call(base, "alice", "POST", "/admin/status")).status).toBe(405);
  });
});

describe("admin settings", () => {
  it("GET returns the settings, PUT updates part of them and records who did it", async () => {
    const { base, db } = await start();
    const got = (await (await call(base, "alice", "GET", "/admin/settings")).json()) as Record<
      string,
      unknown
    >;
    expect(got).toMatchObject({ ...seed, updatedBy: "seed" });

    const put = await call(base, "alice", "PUT", "/admin/settings", {
      turnBudget: 5,
      reasoning: "low",
    });
    expect(await put.json()).toMatchObject({
      ...seed,
      turnBudget: 5,
      reasoning: "low",
      updatedBy: "alice",
    });

    const history = (await (
      await call(base, "alice", "GET", "/admin/settings/history")
    ).json()) as {
      history: { changedBy: string; old: Settings | null; new: Settings }[];
    };
    expect(history.history.map((h) => h.changedBy)).toEqual(["alice", "seed"]);
    expect(history.history[0]?.old).toEqual(seed);
    expect(history.history[0]?.new).toMatchObject({ turnBudget: 5, reasoning: "low" });
    expect(db.history).toHaveLength(2);
  });

  it("answers 400 and changes nothing for an invalid update or a body that is not an object", async () => {
    const { base, db } = await start();
    for (const body of [{ turnBudget: 0 }, { defaultModel: "nope" }, { extra: 1 }, [1]]) {
      expect(
        (await call(base, "alice", "PUT", "/admin/settings", body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(db.history).toHaveLength(1);
  });

  it("answers 404 for an unknown admin path and 405 for a wrong method", async () => {
    const { base } = await start();
    expect((await call(base, "alice", "GET", "/admin/nope")).status).toBe(404);
    expect((await call(base, "alice", "DELETE", "/admin/settings")).status).toBe(405);
  });

  it("uses a new default model and reasoning for POST /sessions at once, without a restart", async () => {
    const { base, sessions } = await start();
    const first = (await (await call(base, "bob", "POST", "/sessions", {})).json()) as Record<
      string,
      unknown
    >;
    expect(first).toMatchObject({ provider: "scripted", model: "scripted-1" });
    expect(first.reasoning).toBeUndefined();

    await call(base, "alice", "PUT", "/admin/settings", {
      defaultModel: "scripted/scripted-2",
      reasoning: "medium",
    });
    const second = (await (await call(base, "bob", "POST", "/sessions", {})).json()) as Record<
      string,
      unknown
    >;
    expect(second).toMatchObject({
      provider: "scripted",
      model: "scripted-2",
      reasoning: "medium",
    });
    // The resolved choice is what the session row stores.
    expect(sessions[1]?.slice(3, 6)).toEqual(["scripted", "scripted-2", "medium"]);

    // The allowlist applies too: a model that was dropped is refused.
    await call(base, "alice", "PUT", "/admin/settings", { allowlist: ["scripted/scripted-2"] });
    expect(
      (await call(base, "bob", "POST", "/sessions", { provider: "scripted", model: "scripted-1" }))
        .status,
    ).toBe(400);
  });

  it("takes a per-request reasoning level, refuses an invalid one and uses the settings default when omitted", async () => {
    const { base, sessions } = await start();
    const post = async (body: unknown) => call(base, "bob", "POST", "/sessions", body);
    const high = await post({ reasoning: "high" });
    expect(high.status).toBe(201);
    expect(await high.json()).toMatchObject({ reasoning: "high" });
    expect(sessions[0]?.[5]).toBe("high");

    for (const reasoning of ["ultra", 3, null]) {
      const bad = await post({ reasoning });
      expect(bad.status, String(reasoning)).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toMatch(/reasoning must be one of/);
    }
    expect(sessions).toHaveLength(1);

    // Omitted: none stored while the settings have no default, the settings default once they do.
    expect(((await (await post({})).json()) as Record<string, unknown>).reasoning).toBeUndefined();
    await call(base, "alice", "PUT", "/admin/settings", { reasoning: "low" });
    expect(await (await post({})).json()).toMatchObject({ reasoning: "low" });
    expect(await (await post({ reasoning: "off" })).json()).toMatchObject({ reasoning: "off" });
  });

  it("refuses a level above the operator cap and takes one at it; a null cap lifts it", async () => {
    const { base } = await start();
    const post = async (reasoning: string) => call(base, "bob", "POST", "/sessions", { reasoning });
    expect((await post("max")).status).toBe(201);

    const put = await call(base, "alice", "PUT", "/admin/settings", { maxReasoning: "medium" });
    expect(await put.json()).toMatchObject({ maxReasoning: "medium" });
    expect((await post("medium")).status).toBe(201);
    const over = await post("high");
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toMatch(
      /above the allowed maximum medium/,
    );

    await call(base, "alice", "PUT", "/admin/settings", { maxReasoning: null });
    expect((await post("high")).status).toBe(201);
  });

  it("refuses a cap below the default reasoning and a default above the cap, changing nothing", async () => {
    const { base, db } = await start();
    await call(base, "alice", "PUT", "/admin/settings", { reasoning: "high" });
    const before = db.history.length;
    for (const body of [{ maxReasoning: "low" }, { maxReasoning: "ultra" }]) {
      expect((await call(base, "alice", "PUT", "/admin/settings", body)).status).toBe(400);
    }
    await call(base, "alice", "PUT", "/admin/settings", { reasoning: null, maxReasoning: "low" });
    expect(
      (await call(base, "alice", "PUT", "/admin/settings", { reasoning: "high" })).status,
    ).toBe(400);
    expect(db.history).toHaveLength(before + 1);
  });
});

describe("admin shard status", () => {
  it("returns persisted status with no Kubernetes access, and rejects writes", async () => {
    const { base } = await start();
    const response = await call(base, "alice", "GET", "/admin/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      shards: [
        {
          shard: 0,
          configuredRuntime: "gvisor",
          observedRuntime: null,
          networkPolicy: "unknown",
          networkPolicyCheckedAt: null,
          networkPolicyDetail: null,
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      ],
      networkPolicy: { state: "unknown", checkedAt: null, detail: null },
    });
    expect((await call(base, "alice", "POST", "/admin/status")).status).toBe(405);
    expect((await call(base, "alice", "GET", "/admin/status/extra")).status).toBe(404);
  }, 10000);
});
