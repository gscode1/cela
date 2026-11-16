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
  turnBudget: 100,
};

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
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), seed);
  const sessions: unknown[][] = [];
  const query = db.query.bind(db);
  db.query = (sql, params) => {
    if (sql.startsWith("insert into inbox.sessions")) {
      sessions.push(params ?? []);
      return Promise.resolve({ rows: [], rowCount: 0 });
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
});
