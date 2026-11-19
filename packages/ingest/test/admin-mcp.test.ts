import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(admins: string[] = ["alice"]): Promise<{ base: string; db: FakeSettingsDb }> {
  const db = new FakeSettingsDb();
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: "http://unused",
    settings: {
      get: () => {
        throw new Error("not used");
      },
      policy: () => {
        throw new Error("not used");
      },
      refresh: () => Promise.resolve(),
    },
    admins,
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, db };
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

const DEMO = { url: "https://mcp.example.com/mcp", readOnly: true };

describe("admin MCP servers authorization", () => {
  it("answers 401 without a token and 403 to a non-admin on every route, and nothing is written", async () => {
    const { base, db } = await start();
    const routes: [string, string, unknown?][] = [
      ["GET", "/admin/mcp-servers"],
      ["GET", "/admin/mcp-servers/history"],
      ["GET", "/admin/mcp-servers/demo"],
      ["PUT", "/admin/mcp-servers/demo", DEMO],
      ["DELETE", "/admin/mcp-servers/demo"],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(base, undefined, method, path, body)).status, `${method} ${path}`).toBe(
        401,
      );
      expect((await call(base, "bob", method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(db.mcp.size).toBe(0);
    expect(db.mcpHistory).toHaveLength(0);
  });

  it("makes nobody an admin when the list is empty", async () => {
    const { base } = await start([]);
    expect((await call(base, "alice", "GET", "/admin/mcp-servers")).status).toBe(403);
  });
});

describe("admin MCP servers", () => {
  it("creates with 201, updates with 200, lists, gets, and records who did what", async () => {
    const { base } = await start();
    const created = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "demo",
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      enabled: true,
      readOnly: true,
      timeoutMs: 60_000,
      maxOutputBytes: 24_576,
      onecliSecret: null,
      reachability: "unknown",
      discovery: { state: "unknown", tools: 0, checkedAt: null },
      createdBy: "alice",
    });
    const updated = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", {
      enabled: false,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ enabled: false, url: DEMO.url });

    const list = (await (await call(base, "alice", "GET", "/admin/mcp-servers")).json()) as {
      servers: { name: string; enabled: boolean }[];
      invalid: unknown[];
    };
    expect(list.servers.map((s) => [s.name, s.enabled])).toEqual([["demo", false]]);
    expect(list.invalid).toEqual([]);
    expect(
      await (await call(base, "alice", "GET", "/admin/mcp-servers/demo")).json(),
    ).toMatchObject({ name: "demo", enabled: false });

    const history = (await (
      await call(base, "alice", "GET", "/admin/mcp-servers/history")
    ).json()) as { history: { action: string; changedBy: string; old: unknown }[] };
    expect(history.history.map((h) => h.action)).toEqual(["update", "create"]);
    expect(history.history[1]?.old).toBeNull();
  });

  it("reports the orchestrator's discovery outcome per server (ADR 0044)", async () => {
    const { base, db } = await start();
    for (const name of ["good", "bad", "off", "silent"]) {
      await call(base, "alice", "PUT", `/admin/mcp-servers/${name}`, {
        ...DEMO,
        enabled: name !== "off",
      });
    }
    const at = "2026-11-19T10:00:00.000Z";
    db.mcpDiscovery = [
      {
        shard: 0,
        mcpDiscovery: {
          good: { state: "ready", tools: 2, toolNames: ["a", "b"], checkedAt: at },
          bad: {
            state: "failed",
            error: "mcp bad connect timed out after 15000 ms",
            checkedAt: at,
          },
          off: { state: "ready", tools: 1, toolNames: ["x"], checkedAt: at },
        },
      },
    ];
    const list = (await (await call(base, "alice", "GET", "/admin/mcp-servers")).json()) as {
      servers: { name: string; reachability: string; discovery: unknown }[];
    };
    const by = Object.fromEntries(list.servers.map((s) => [s.name, s]));
    expect(by.good).toMatchObject({
      reachability: "ok",
      discovery: { state: "ready", tools: 2, toolNames: ["a", "b"], checkedAt: at, shard: 0 },
    });
    expect(by.bad).toMatchObject({
      reachability: "failing",
      discovery: {
        state: "failed",
        error: "mcp bad connect timed out after 15000 ms",
        checkedAt: at,
      },
    });
    expect(by.off).toMatchObject({ reachability: "unknown", discovery: { state: "disabled" } });
    expect(by.silent).toMatchObject({ reachability: "unknown", discovery: { state: "unknown" } });
    expect(await (await call(base, "alice", "GET", "/admin/mcp-servers/bad")).json()).toMatchObject(
      { reachability: "failing" },
    );
  });

  it("derives the egress rules of the catalog in the same transaction (ADR 0040)", async () => {
    const { base, db } = await start();
    const rules = () => db.egress.rules.map((r) => [r.rule_set, r.host, r.route, r.created_by]);
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO);
    expect(rules()).toEqual([["mcp-catalog", "mcp.example.com", "direct", "alice"]]);
    // One NOTIFY on the egress channel for the write, committed with the catalog row.
    expect(db.egress.notifications).toHaveLength(1);
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", { onecliSecret: "demo-key" });
    expect(rules()).toEqual([["mcp-catalog", "mcp.example.com", "onecli", "alice"]]);
    // A no-op PUT writes nothing, rules included.
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", { onecliSecret: "demo-key" });
    expect(db.egress.notifications).toHaveLength(2);
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", { enabled: false });
    expect(rules()).toEqual([]);
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", { enabled: true });
    expect(rules()).toHaveLength(1);
    const gone = await call(base, "alice", "DELETE", "/admin/mcp-servers/demo?expectedRevision=4");
    expect(gone.status).toBe(200);
    expect(rules()).toEqual([]);
    // The history of the rules names the admin who changed the catalog.
    expect(db.egress.history.every((h) => h.changed_by === "alice")).toBe(true);
  });

  it("rolls the catalog write back when the derived rules cannot be written", async () => {
    const { base, db } = await start();
    const query = db.query.bind(db);
    db.query = (sql, params) =>
      sql.includes("insert into egress.revisions")
        ? Promise.reject(new Error("egress is unavailable"))
        : query(sql, params);
    const res = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO);
    expect(res.status).toBe(500);
    expect(db.mcp.size).toBe(0);
    expect(db.mcpHistory).toHaveLength(0);
    expect(db.egress.rules).toEqual([]);
  });

  it("DELETE removes the row for real and puts the delete in the history; a second DELETE is 404", async () => {
    const { base, db } = await start();
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO);
    // The revision is required (ADR 0027).
    expect((await call(base, "alice", "DELETE", "/admin/mcp-servers/demo")).status).toBe(400);
    const gone = await call(base, "alice", "DELETE", "/admin/mcp-servers/demo?expectedRevision=1");
    expect(gone.status).toBe(200);
    expect(db.mcp.size).toBe(0);
    expect(
      (await call(base, "alice", "DELETE", "/admin/mcp-servers/demo?expectedRevision=1")).status,
    ).toBe(404);
    expect((await call(base, "alice", "GET", "/admin/mcp-servers/demo")).status).toBe(404);
    const history = (await (
      await call(base, "alice", "GET", "/admin/mcp-servers/history?name=demo&limit=1")
    ).json()) as { history: { action: string; old: { url: string }; new: unknown }[] };
    expect(history.history).toHaveLength(1);
    expect(history.history[0]).toMatchObject({
      action: "delete",
      old: { url: DEMO.url },
      new: null,
    });
  });

  it("lists the OneCLI secret names the orchestrator published, and says when they are unknown", async () => {
    const { base, db } = await start();
    const list = async () =>
      (
        (await (await call(base, "alice", "GET", "/admin/mcp-servers")).json()) as {
          onecliSecrets: unknown;
        }
      ).onecliSecrets;
    expect(await list()).toEqual({ names: [], source: "none" });
    db.capabilities = { tools: [], extensions: [], instance: "o" };
    expect(await list()).toEqual({ names: [], source: "none" });
    db.capabilities = { tools: [], extensions: [], instance: "o", onecli_secret_names: [] };
    expect(await list()).toEqual({ names: [], source: "orchestrator" });
    db.capabilities = {
      tools: [],
      extensions: [],
      instance: "o",
      onecli_secret_names: ["github-mcp", "linear-mcp"],
    };
    expect(await list()).toEqual({ names: ["github-mcp", "linear-mcp"], source: "orchestrator" });
    // Admins only: the names are not values, but they still describe the deployment.
    const denied = await call(base, "bob", "GET", "/admin/mcp-servers");
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("github-mcp");
  });

  it("stores, shows and clears a server's onecliSecret", async () => {
    const { base } = await start();
    const created = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", {
      ...DEMO,
      onecliSecret: "github-mcp",
    });
    expect(await created.json()).toMatchObject({ onecliSecret: "github-mcp", revision: 1 });
    const cleared = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", {
      onecliSecret: null,
      expectedRevision: 1,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ onecliSecret: null, revision: 2 });
    const bad = await call(base, "alice", "PUT", "/admin/mcp-servers/demo", {
      onecliSecret: "has space",
    });
    expect(bad.status).toBe(400);
  });

  it("answers 400 and writes nothing for an invalid server, name or body", async () => {
    const { base, db } = await start();
    const bad: [string, unknown][] = [
      ["demo", { ...DEMO, url: "http://mcp.example.com/" }],
      ["demo", { ...DEMO, url: "https://u:p@mcp.example.com/" }],
      ["demo", { url: DEMO.url }],
      ["demo", { ...DEMO, transport: "stdio" }],
      ["demo", { ...DEMO, name: "other" }],
      ["demo", { ...DEMO, extra: 1 }],
      ["demo", { ...DEMO, timeoutMs: 1 }],
      ["Demo", DEMO],
      ["a_b", DEMO],
    ];
    for (const [name, body] of bad) {
      const res = await call(base, "alice", "PUT", `/admin/mcp-servers/${name}`, body);
      expect(res.status, name + JSON.stringify(body)).toBe(400);
    }
    expect((await call(base, "alice", "PUT", "/admin/mcp-servers/demo", "[1]")).status).toBe(400);
    // "history" is the history route; the validator reserves the name too, so no row could ever be reached by it.
    expect((await call(base, "alice", "PUT", "/admin/mcp-servers/history", DEMO)).status).toBe(405);
    expect(db.mcp.size).toBe(0);
    expect(db.mcpHistory).toHaveLength(0);
  });

  it("a partial update of a server that does not exist needs the required fields", async () => {
    const { base } = await start();
    expect(
      (await call(base, "alice", "PUT", "/admin/mcp-servers/demo", { enabled: false })).status,
    ).toBe(400);
  });

  it("answers 404 for unknown paths and 405 for a wrong method", async () => {
    const { base } = await start();
    expect((await call(base, "alice", "GET", "/admin/mcp-servers/a/b/c")).status).toBe(404);
    expect((await call(base, "alice", "POST", "/admin/mcp-servers", {})).status).toBe(405);
    expect((await call(base, "alice", "POST", "/admin/mcp-servers/demo", {})).status).toBe(405);
  });

  it("a write sends one notification on pi_mcp_servers, in the transaction", async () => {
    const { base, db } = await start();
    const seen: string[] = [];
    const listener = await db.connect();
    listener.on("notification", (n: { channel: string }) => seen.push(n.channel));
    await listener.query("listen pi_mcp_servers");
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO);
    await call(base, "alice", "PUT", "/admin/mcp-servers/demo", DEMO); // no change, no notification
    await call(base, "alice", "DELETE", "/admin/mcp-servers/demo?expectedRevision=1");
    expect(seen).toEqual(["pi_mcp_servers", "pi_mcp_servers"]);
  });
});
