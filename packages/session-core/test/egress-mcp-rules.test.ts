import { describe, expect, it } from "vitest";
import {
  deriveMcpRules,
  MCP_RULE_SET,
  mcpRuleNote,
  syncMcpRules,
} from "../src/egress-mcp-rules.ts";
import {
  createEgressRule,
  deleteEgressRule,
  deleteRuleSet,
  readEgress,
  updateEgressRule,
  updateRuleSet,
} from "../src/egress-store.ts";
import type { McpServerConfig } from "../src/mcp-servers.ts";
import { AdminConflictError } from "../src/revision.ts";
import { FakeEgressDb } from "./fake-egress-db.ts";

const server = (
  name: string,
  url: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig => ({
  name,
  url,
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret: null,
  ...extra,
});

/** A pool-like client over the fake that begins and commits, like the catalog write's transaction. */
async function inTransaction<T>(db: FakeEgressDb, work: (client: never) => Promise<T>): Promise<T> {
  const client = await db.connect();
  await client.query("begin");
  try {
    const result = await work(client as never);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function seeded(): FakeEgressDb {
  const db = new FakeEgressDb();
  db.ruleSets.push({
    name: MCP_RULE_SET,
    description: "derived",
    applies_to_all: false,
    system: true,
    revision: 1,
    created_at: "2026-11-18T12:00:00Z",
    created_by: "mcp-catalog",
    updated_at: "2026-11-18T12:00:00Z",
    updated_by: "mcp-catalog",
  });
  db.revisions.push({ revision: 1, changed_by: "migration 029" });
  return db;
}

describe("deriveMcpRules", () => {
  it("makes one rule per host: onecli for a credentialed server, direct otherwise", () => {
    const derived = deriveMcpRules([
      server("deepwiki", "https://mcp.deepwiki.com/mcp"),
      server("docs", "https://api.example.com/mcp", { onecliSecret: "docs-key" }),
    ]);
    expect(derived.skipped).toEqual([]);
    expect(derived.rules).toEqual([
      { host: "api.example.com", ports: [443], route: "onecli", servers: ["docs"] },
      { host: "mcp.deepwiki.com", ports: [443], route: "direct", servers: ["deepwiki"] },
    ]);
  });

  it("never names two routes for a host: the credentialed server wins, the ports are joined", () => {
    const derived = deriveMcpRules([
      server("a", "https://mcp.example.com/a"),
      server("b", "https://mcp.example.com:8443/b", { onecliSecret: "b-key" }),
    ]);
    expect(derived.rules).toEqual([
      { host: "mcp.example.com", ports: [443, 8443], route: "onecli", servers: ["a", "b"] },
    ]);
  });

  it("gives a disabled server no rule, and skips a server it cannot name by host", () => {
    const derived = deriveMcpRules([
      server("off", "https://off.example.com/", { enabled: false }),
      server("ip", "https://203.0.113.9/mcp"),
      server("v6", "https://[2001:db8::1]/mcp"),
    ]);
    expect(derived.rules).toEqual([]);
    expect(derived.skipped.map((s) => s.server)).toEqual(["ip", "v6"]);
  });

  it("keeps the note within the rule limit however many servers share a host", () => {
    const names = Array.from({ length: 60 }, (_, i) => `server-with-a-long-name-${String(i)}`);
    expect(mcpRuleNote(names).length).toBeLessThanOrEqual(500);
  });
});

describe("syncMcpRules", () => {
  it("creates, changes and removes only what differs, under one revision and one notification", async () => {
    const db = seeded();
    const first = await inTransaction(db, (c) =>
      syncMcpRules(c, [server("deepwiki", "https://mcp.deepwiki.com/mcp")], "alice"),
    );
    expect(first.rules).toHaveLength(1);
    expect(db.rules).toMatchObject([
      {
        rule_set: MCP_RULE_SET,
        host: "mcp.deepwiki.com",
        route: "direct",
        ports: [443],
        created_by: "alice",
      },
    ]);
    expect(db.revision).toBe(2);
    expect(db.notifications).toEqual(["2"]);
    expect(db.history.map((h) => [h.kind, h.action, h.changed_by])).toEqual([
      ["rule", "create", "alice"],
    ]);
    // The history row names the rule (the id exists only after the insert).
    expect(db.history[0]?.ref).toBe(String(db.rules[0]?.id));

    // The same catalog again writes nothing: no revision, no notification.
    await inTransaction(db, (c) =>
      syncMcpRules(c, [server("deepwiki", "https://mcp.deepwiki.com/mcp")], "alice"),
    );
    expect(db.revision).toBe(2);
    expect(db.notifications).toEqual(["2"]);

    // A secret on the server flips the route in place (same rule id).
    const id = db.rules[0]?.id;
    await inTransaction(db, (c) =>
      syncMcpRules(
        c,
        [server("deepwiki", "https://mcp.deepwiki.com/mcp", { onecliSecret: "k" })],
        "alice",
      ),
    );
    expect(db.rules).toMatchObject([{ id, route: "onecli" }]);
    expect(db.revision).toBe(3);

    // Disabling or deleting the server removes the rule.
    await inTransaction(db, (c) => syncMcpRules(c, [], "alice"));
    expect(db.rules).toEqual([]);
    expect(db.revision).toBe(4);
    expect(db.notifications).toEqual(["2", "3", "4"]);
  });

  it("rolls back with the transaction: nothing is written or notified when the catalog write fails", async () => {
    const db = seeded();
    await expect(
      inTransaction(db, async (c) => {
        await syncMcpRules(c, [server("a", "https://a.example.com/")], "alice");
        throw new Error("the catalog write failed after the derivation");
      }),
    ).rejects.toThrow("failed");
    expect(db.rules).toEqual([]);
    expect(db.revision).toBe(1);
    expect(db.notifications).toEqual([]);
    expect(db.history).toEqual([]);
  });

  it("replaces a row that does not belong (a stale host) and a duplicate of a host", async () => {
    const db = seeded();
    await inTransaction(db, (c) => syncMcpRules(c, [server("a", "https://a.example.com/")], "x"));
    const first = db.rules[0];
    if (first === undefined) throw new Error("no derived rule");
    db.rules.push({ ...first, id: 99 });
    db.rules.push({ ...first, id: 100, host: "gone.example.com" });
    await inTransaction(db, (c) => syncMcpRules(c, [server("a", "https://a.example.com/")], "x"));
    expect(db.rules.map((r) => r.host)).toEqual(["a.example.com"]);
  });

  it("restores the set when a database lost the row", async () => {
    const db = new FakeEgressDb();
    await inTransaction(db, (c) => syncMcpRules(c, [server("a", "https://a.example.com/")], "x"));
    expect(db.ruleSets).toMatchObject([
      { name: MCP_RULE_SET, system: true, applies_to_all: false },
    ]);
    expect(db.rules).toHaveLength(1);
  });
});

describe("the derived set is read-only for the admin API", () => {
  it("refuses to edit or delete the set, and to add, change or delete its rules", async () => {
    const db = seeded();
    await inTransaction(db, (c) => syncMcpRules(c, [server("a", "https://a.example.com/")], "x"));
    const pool = db.asPool();
    const id = String(db.rules[0]?.id);
    const before = JSON.stringify([db.ruleSets, db.rules, db.revision]);
    await expect(updateRuleSet(pool, MCP_RULE_SET, { appliesToAll: true }, "bob")).rejects.toThrow(
      AdminConflictError,
    );
    await expect(deleteRuleSet(pool, MCP_RULE_SET, "bob")).rejects.toThrow(/derived from the MCP/);
    await expect(
      createEgressRule(
        pool,
        { ruleSet: MCP_RULE_SET },
        { effect: "allow", host: "x.example.com" },
        "bob",
      ),
    ).rejects.toThrow(AdminConflictError);
    await expect(updateEgressRule(pool, id, { host: "b.example.com" }, "bob")).rejects.toThrow(
      AdminConflictError,
    );
    await expect(deleteEgressRule(pool, id, "bob")).rejects.toThrow(AdminConflictError);
    expect(JSON.stringify([db.ruleSets, db.rules, db.revision])).toBe(before);
    const data = await readEgress(pool);
    expect(data.ruleSets.find((s) => s.name === MCP_RULE_SET)?.system).toBe(true);
  });
});
