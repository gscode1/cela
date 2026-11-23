import { describe, expect, it } from "vitest";
import {
  deleteMcpServer,
  listMcpServerHistory,
  putMcpServer,
  readMcpServers,
  validateMcpServer,
} from "../src/mcp-servers.ts";
import type { McpServerConfig } from "../src/mcp-servers.ts";
import { putProfile } from "../src/profiles.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const BASE = { url: "https://mcp.example.com/mcp", readOnly: true };
const FULL: McpServerConfig = {
  name: "demo",
  url: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret: null,
};

describe("validateMcpServer", () => {
  it("fills the defaults of a create and normalises the url", () => {
    expect(validateMcpServer("demo", { ...BASE, url: "https://MCP.example.com" })).toEqual({
      ...FULL,
      url: "https://mcp.example.com/",
    });
  });

  it("lays a partial update over the current server", () => {
    expect(validateMcpServer("demo", { enabled: false, timeoutMs: 5000 }, FULL)).toEqual({
      ...FULL,
      enabled: false,
      timeoutMs: 5000,
    });
  });

  it.each([
    ["an uppercase name", "Demo", BASE],
    ["a name with an underscore", "a_b", BASE],
    ["a name of 33 characters", "a".repeat(33), BASE],
    ["a missing url", "demo", { readOnly: true }],
    ["an http url", "demo", { ...BASE, url: "http://mcp.example.com/" }],
    ["a url with credentials", "demo", { ...BASE, url: "https://u:p@mcp.example.com/" }],
    ["a url that is not a url", "demo", { ...BASE, url: "mcp.example.com" }],
    [
      "a url over 2048 characters once spaces become %20",
      "demo",
      { ...BASE, url: `https://a.example/a${" ".repeat(800)}b` },
    ],
    [
      "a url over 2048 characters",
      "demo",
      { ...BASE, url: `https://a.example/${"x".repeat(2048)}` },
    ],
    ["no readOnly declaration", "demo", { url: BASE.url }],
    ["a stdio transport", "demo", { ...BASE, transport: "stdio" }],
    ["a non-boolean enabled", "demo", { ...BASE, enabled: "yes" }],
    ["a timeout under 1 s", "demo", { ...BASE, timeoutMs: 999 }],
    ["a timeout over 5 min", "demo", { ...BASE, timeoutMs: 300_001 }],
    ["a fractional timeout", "demo", { ...BASE, timeoutMs: 1500.5 }],
    ["an output cap under 1 KiB", "demo", { ...BASE, maxOutputBytes: 100 }],
    ["an output cap over 24 KiB", "demo", { ...BASE, maxOutputBytes: 24_577 }],
    ["a secret with spaces", "demo", { ...BASE, onecliSecret: "my secret" }],
    ["an unknown field", "demo", { ...BASE, token: "x" }],
    ["a different name in the body", "demo", { ...BASE, name: "other" }],
    ["an array body", "demo", []],
  ])("rejects %s", (_label, name, body) => {
    expect(typeof validateMcpServer(name, body)).toBe("string");
  });

  it("accepts the name in the body when it matches the path, and a secret reference", () => {
    const result = validateMcpServer("demo", { ...BASE, name: "demo", onecliSecret: "sec_1:abc" });
    expect(result).toMatchObject({ name: "demo", onecliSecret: "sec_1:abc" });
  });
});

describe("the catalog in the database", () => {
  it("creates, updates and deletes with a history entry and a notification each", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const created = await putMcpServer(pool, "demo", BASE, "alice");
    expect(created).toMatchObject({ created: true, stored: { server: FULL, createdBy: "alice" } });
    const updated = await putMcpServer(pool, "demo", { enabled: false }, "bob");
    expect(updated).toMatchObject({
      created: false,
      stored: { server: { enabled: false }, createdBy: "alice", updatedBy: "bob" },
    });
    expect(await deleteMcpServer(pool, "demo", "carol", 2)).toBe(true);
    expect(await deleteMcpServer(pool, "demo", "carol", 2)).toBe(false);
    expect((await readMcpServers(pool)).servers).toEqual([]);
    const history = await listMcpServerHistory(pool, 10);
    expect(history.map((h) => [h.action, h.changedBy, h.old === null, h.new === null])).toEqual([
      ["delete", "carol", false, true],
      ["update", "bob", false, false],
      ["create", "alice", true, false],
    ]);
    expect(await listMcpServerHistory(pool, 10, "other")).toEqual([]);
  });

  it("writes nothing and notifies nobody for a change that alters nothing, or for a rejected one", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    await putMcpServer(pool, "demo", BASE, "alice");
    const seen: string[] = [];
    const listener = await db.connect();
    listener.on("notification", (n: { channel: string }) => seen.push(n.channel));
    await listener.query("listen pi_mcp_servers");
    expect(await putMcpServer(pool, "demo", { enabled: true }, "alice")).toMatchObject({
      created: false,
    });
    expect(await putMcpServer(pool, "demo", { url: "http://nope" }, "alice")).toMatch(/https/);
    expect(db.mcpHistory).toHaveLength(1);
    expect(seen).toEqual([]);
    await putMcpServer(pool, "demo", { enabled: false }, "alice");
    expect(seen).toEqual(["pi_mcp_servers"]);
  });

  it("rolls the write back, history and all, when the transaction fails", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const query = db.query.bind(db);
    db.query = (sql, params) =>
      sql.includes("insert into inbox.mcp_servers_history")
        ? Promise.reject(new Error("disk full"))
        : query(sql, params);
    await expect(putMcpServer(pool, "demo", BASE, "alice")).rejects.toThrow("disk full");
    expect(db.mcp.size).toBe(0);
  });

  it("never persists a row the read path rejects: whatever a write accepts, a read accepts", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const bodies: unknown[] = [
      BASE,
      { ...BASE, url: "https://EXAMPLE.com:443/a b" },
      { ...BASE, timeoutMs: 1000, maxOutputBytes: 1024, onecliSecret: "a" },
      { ...BASE, enabled: false },
    ];
    for (const [i, body] of bodies.entries()) {
      const result = await putMcpServer(pool, `s${String(i)}`, body, "alice");
      expect(typeof result).not.toBe("string");
    }
    const catalog = await readMcpServers(pool);
    expect(catalog.invalid).toEqual([]);
    expect(catalog.servers).toHaveLength(bodies.length);
  });

  it("serialises concurrent creates of one name: the second sees the first and does not overwrite it", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const [a, b] = await Promise.all([
      putMcpServer(pool, "demo", { ...BASE, enabled: false }, "alice"),
      putMcpServer(pool, "demo", { ...BASE, timeoutMs: 5000 }, "bob"),
    ]);
    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");
    // Whichever ran second updated the first, so exactly one create exists and the other entry has an old value.
    expect(db.mcpHistory.map((h) => h.action).sort()).toEqual(["create", "update"]);
    expect(db.mcpHistory.find((h) => h.action === "update")?.old).not.toBeNull();
    // The update started from what the create wrote, not from nothing.
    const [created, updated] = db.mcpHistory;
    expect(updated?.old).toEqual(created?.new);
  });

  it("reports a row edited by hand into something invalid, and still lists the others", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    await putMcpServer(pool, "good", BASE, "alice");
    await putMcpServer(pool, "bad", BASE, "alice");
    const bad = db.mcp.get("bad");
    if (bad !== undefined) bad.url = "http://plain.example.com/";
    const catalog = await readMcpServers(pool);
    expect(catalog.servers.map((s) => s.server.name)).toEqual(["good"]);
    expect(catalog.invalid).toEqual([
      { name: "bad", message: expect.stringContaining("https") as string },
    ]);
    // A PUT repairs it: the stored row cannot be laid under the body, so the body must be complete.
    expect(await putMcpServer(pool, "bad", { enabled: false }, "alice")).toMatch(/url is required/);
    expect(await putMcpServer(pool, "bad", BASE, "alice")).toMatchObject({ created: false });
  });

  it("runs the `within` hook in the write's transaction: only for a change, and a failing hook rolls the write back", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    let calls = 0;
    const within = () => {
      calls += 1;
      return Promise.resolve();
    };
    await putMcpServer(pool, "demo", BASE, "alice", undefined, { within });
    expect(calls).toBe(1);
    // No change: no write, no hook.
    await putMcpServer(pool, "demo", { enabled: true }, "alice", undefined, { within });
    expect(calls).toBe(1);
    await expect(
      putMcpServer(pool, "demo", { enabled: false }, "alice", undefined, {
        within: () => Promise.reject(new Error("derivation failed")),
      }),
    ).rejects.toThrow("derivation failed");
    // The row and its history are as before: nothing half-written.
    expect(db.mcp.get("demo")?.enabled).toBe(true);
    expect(db.mcpHistory).toHaveLength(1);
    const revision = (await readMcpServers(pool)).servers[0]?.revision ?? 0;
    await expect(
      deleteMcpServer(pool, "demo", "bob", revision, {
        within: () => Promise.reject(new Error("derivation failed")),
      }),
    ).rejects.toThrow("derivation failed");
    expect(db.mcp.has("demo")).toBe(true);
    expect(await deleteMcpServer(pool, "demo", "bob", revision, { within })).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("a credential for a server that a browser or direct profile names (ADR 0041, 0038)", () => {
  const KNOWN = {
    tools: ["read"],
    mcpServers: ["demo"],
    browserFlavourEnabled: true,
    allowDirectEgress: true,
  };

  it.each([
    ["a browser", { sandboxFlavour: "browser" }, "sandboxFlavour browser"],
    ["a direct", { networkMode: "direct" }, "networkMode direct"],
  ])("refuses onecliSecret while %s profile names the server", async (_label, extra, words) => {
    const db = new FakeSettingsDb();
    db.setRow();
    const pool = db.asPool();
    await putMcpServer(pool, "demo", BASE, "alice");
    await putProfile(
      pool,
      "web",
      { definition: { tools: ["read"], mcpServers: ["demo"], ...extra } },
      "alice",
      KNOWN,
    );
    const refused = await putMcpServer(pool, "demo", { onecliSecret: "demo-key" }, "alice");
    expect(refused).toEqual(expect.stringContaining(`web (${words})`));
    expect(db.mcp.get("demo")?.onecli_secret).toBeNull();
    // Clearing the secret and unrelated edits stay possible.
    expect(await putMcpServer(pool, "demo", { enabled: false }, "alice")).toMatchObject({
      created: false,
    });
    // Once the profile no longer names the server, the secret is accepted.
    await putProfile(pool, "web", { definition: { tools: ["read"], ...extra } }, "alice", KNOWN);
    expect(await putMcpServer(pool, "demo", { onecliSecret: "demo-key" }, "alice")).toMatchObject({
      stored: { server: { onecliSecret: "demo-key" } },
    });
  });

  it("allows onecliSecret when only a default-flavour proxied profile names the server", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    const pool = db.asPool();
    await putMcpServer(pool, "demo", BASE, "alice");
    await putProfile(
      pool,
      "plain",
      { definition: { tools: ["read"], mcpServers: ["demo"] } },
      "alice",
      KNOWN,
    );
    expect(await putMcpServer(pool, "demo", { onecliSecret: "demo-key" }, "alice")).toMatchObject({
      stored: { server: { onecliSecret: "demo-key" } },
    });
  });
});
