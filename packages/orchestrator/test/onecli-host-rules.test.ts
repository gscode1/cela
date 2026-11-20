import type pg from "pg";
import { describe, expect, it } from "vitest";
import { syncMcpRules, MCP_RULE_SET } from "@cela/session-core";
import type { McpServerConfig } from "@cela/session-core";
import { FakeEgressDb } from "../../session-core/test/fake-egress-db.ts";
import { OneCliAdmin } from "../src/onecli-admin.ts";
import {
  desiredHosts,
  HostRuleReconciler,
  OWNED_PREFIX,
  patternCovers,
  planHostRules,
} from "../src/onecli-host-rules.ts";
import { Redacted } from "../src/onecli.ts";
import { FakeOneCli } from "./fake-onecli.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const mcp = (name: string, url: string, onecliSecret: string | null = null): McpServerConfig => ({
  name,
  url,
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret,
});

/** The fake database with the derived set seeded, and a helper that runs the catalog derivation in a transaction. */
async function withCatalog(db: FakeEgressDb, servers: McpServerConfig[]): Promise<void> {
  if (!db.ruleSets.some((s) => s.name === MCP_RULE_SET)) {
    db.ruleSets.push({
      name: MCP_RULE_SET,
      description: "",
      applies_to_all: false,
      system: true,
      revision: 1,
      created_at: NOW.toISOString(),
      created_by: "x",
      updated_at: NOW.toISOString(),
      updated_by: "x",
    });
  }
  const client = await db.connect();
  await client.query("begin");
  await syncMcpRules(client as unknown as pg.PoolClient, servers, "alice");
  await client.query("commit");
  client.release();
}

function setUp() {
  const fake = new FakeOneCli();
  const onecli = new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), fake.fetch, {
    timeoutMs: 1000,
    retries: 0,
    backoffMs: 1,
    maxBackoffMs: 1,
  });
  const db = new FakeEgressDb();
  const changed: number[] = [];
  const reconciler = new HostRuleReconciler({
    pool: db.asPool(),
    onecli,
    now: () => NOW,
    onChanged: () => changed.push(1),
  });
  return { fake, db, reconciler, changed };
}

const owned = (fake: FakeOneCli) =>
  fake.hostRules
    .filter((r) => r.name.startsWith(OWNED_PREFIX))
    .map((r) => r.targets[0]?.hostPattern);

describe("desiredHosts", () => {
  it("takes route=onecli allows from any owner, and every host of the derived MCP set whatever its route", async () => {
    const db = new FakeEgressDb();
    await withCatalog(db, [
      mcp("a", "https://a.example.com/"),
      mcp("b", "https://b.example.com/", "k"),
    ]);
    const base = db.ruleSets[0];
    if (base === undefined) throw new Error("no seeded set");
    db.ruleSets.push({ ...base, name: "web", system: false });
    const rule = (over: object) => ({
      id: db.rules.length + 100,
      rule_set: "web",
      session_id: null,
      effect: "allow",
      host: "x.example.com",
      ports: [443],
      route: "direct",
      allows_private: false,
      expires_at: null,
      note: "",
      revision: 1,
      created_at: NOW.toISOString(),
      created_by: "x",
      updated_at: NOW.toISOString(),
      updated_by: "x",
      ...over,
    });
    db.rules.push(
      rule({ host: "direct.example.com" }),
      rule({ host: "via.example.com", route: "onecli" }),
      rule({ host: ".suffix.example.com", route: "onecli" }),
      rule({ host: "denied.example.com", route: "direct", effect: "deny" }),
      rule({ host: "expired.example.com", route: "onecli", expires_at: "2026-01-01T00:00:00Z" }),
      rule({ host: "session.example.com", route: "onecli", rule_set: null, session_id: "s1" }),
    );
    const { readEgress } = await import("@cela/session-core");
    const wanted = desiredHosts(await readEgress(db.asPool()), NOW);
    expect([...wanted.keys()].sort()).toEqual([
      "*.suffix.example.com",
      "a.example.com",
      "b.example.com",
      "session.example.com",
      "via.example.com",
    ]);
  });
});

describe("planHostRules", () => {
  const rule = (
    id: string,
    name: string,
    action: "allow" | "block",
    pattern: string,
    priority: number,
  ) => ({
    id,
    name,
    action,
    priority,
    enabled: true,
    description: "",
    hostPatterns: [pattern],
  });

  it("covers a host with a hand-made allow in front of the block, but not one behind it", () => {
    const rules = [
      rule("1", "pi-allow-a.example.com", "allow", "a.example.com", 1),
      rule("2", "pi-block-all", "block", "*", 2),
      rule("3", "late", "allow", "b.example.com", 3),
    ];
    const plan = planHostRules(
      new Map([
        ["a.example.com", 1],
        ["b.example.com", 1],
      ]),
      rules,
    );
    expect(plan.create).toEqual(["b.example.com"]);
    expect(plan.relocate.map((r) => r.id)).toEqual(["2"]);
  });

  it("matches wildcards the way the gateway does: *.x covers a.x and *.a.x, not x", () => {
    expect(patternCovers("*.x.com", "a.x.com")).toBe(true);
    expect(patternCovers("*.x.com", "*.a.x.com")).toBe(true);
    expect(patternCovers("*.x.com", "x.com")).toBe(false);
    expect(patternCovers("a.x.com", "b.x.com")).toBe(false);
  });

  it("is empty when everything is in place, and removes only owned allows nobody wants", () => {
    const rules = [
      rule("1", "pi-allow-github.com", "allow", "github.com", 1),
      rule("2", `${OWNED_PREFIX}a.example.com`, "allow", "a.example.com", 2),
      rule("3", `${OWNED_PREFIX}gone.example.com`, "allow", "gone.example.com", 3),
      rule("4", "pi-block-all", "block", "*", 4),
    ];
    const plan = planHostRules(
      new Map([
        ["a.example.com", 1],
        ["github.com", 1],
      ]),
      rules,
    );
    expect(plan.create).toEqual([]);
    expect(plan.remove.map((r) => r.id)).toEqual(["3"]);
    expect(plan.relocate.map((r) => r.id)).toEqual([]);
  });

  it("does not create a block that is not there, and leaves a rule of an unknown shape alone", () => {
    const odd = { ...rule("1", "odd", "allow", "x", 1), hostPatterns: null };
    const plan = planHostRules(new Map([["a.example.com", 1]]), [odd]);
    expect(plan).toEqual({ create: ["a.example.com"], remove: [], relocate: [], drop: [] });
  });
});

describe("HostRuleReconciler", () => {
  it("makes a catalog host reachable, never touches hand-made rules, and a second pass changes nothing", async () => {
    const { fake, db, reconciler, changed } = setUp();
    // What the operator's script made: baseline allows, a hand-made rule of its own, the terminal block.
    fake.addHostRule("pi-allow-openrouter.ai", "allow", "openrouter.ai");
    fake.addHostRule("handmade-allow", "allow", "handmade.example.com");
    fake.addHostRule("pi-block-all", "block", "*");
    const handMadeBefore = JSON.stringify(
      fake.hostRules.filter((r) => !r.name.startsWith(OWNED_PREFIX) && r.action === "allow"),
    );
    expect(fake.hostAllowed("mcp.example.com")).toBe(false);

    await withCatalog(db, [mcp("demo", "https://mcp.example.com/mcp")]);
    const first = await reconciler.reconcile();
    expect(first).toEqual({
      created: ["mcp.example.com"],
      removed: [],
      relocated: ["pi-block-all"],
    });
    expect(fake.hostAllowed("mcp.example.com")).toBe(true);
    expect(fake.hostAllowed("other.example.com")).toBe(false);
    expect(fake.hostAllowed("openrouter.ai")).toBe(true);
    expect(fake.hostAllowed("handmade.example.com")).toBe(true);
    // The block was recreated once (one block, the same name) and the hand-made allows are byte for byte as they were.
    expect(fake.hostRules.filter((r) => r.action === "block").map((r) => r.name)).toEqual([
      "pi-block-all",
    ]);
    expect(
      JSON.stringify(
        fake.hostRules.filter((r) => !r.name.startsWith(OWNED_PREFIX) && r.action === "allow"),
      ),
    ).toBe(handMadeBefore);
    expect(changed).toHaveLength(1);

    const calls = fake.calls.length;
    expect(await reconciler.reconcile()).toEqual({ created: [], removed: [], relocated: [] });
    expect(fake.calls.slice(calls)).toEqual(["GET /v1/org/policy/rules"]);
    expect(changed).toHaveLength(1);
  });

  it("removes a host when its server leaves the catalog, and a credentialed server's host is added as well", async () => {
    const { fake, db, reconciler } = setUp();
    fake.addHostRule("pi-block-all", "block", "*");
    await withCatalog(db, [
      mcp("a", "https://a.example.com/"),
      mcp("b", "https://b.example.com/", "key"),
    ]);
    await reconciler.reconcile();
    expect(owned(fake).sort()).toEqual(["a.example.com", "b.example.com"]);
    await withCatalog(db, [mcp("b", "https://b.example.com/", "key")]);
    const result = await reconciler.reconcile();
    expect(result?.removed).toEqual(["a.example.com"]);
    expect(owned(fake)).toEqual(["b.example.com"]);
    expect(fake.hostAllowed("a.example.com")).toBe(false);
    await withCatalog(db, []);
    await reconciler.reconcile();
    expect(owned(fake)).toEqual([]);
    expect(fake.hostRules.map((r) => r.name)).toEqual(["pi-block-all"]);
  });

  it("repairs an owned rule that was deleted by hand, and keeps the gate shut while it moves the block", async () => {
    const { fake, db, reconciler } = setUp();
    fake.addHostRule("pi-block-all", "block", "*");
    await withCatalog(db, [mcp("a", "https://a.example.com/")]);
    await reconciler.reconcile();
    fake.hostRules.splice(
      fake.hostRules.findIndex((r) => r.name.startsWith(OWNED_PREFIX)),
      1,
    );
    expect(fake.hostAllowed("a.example.com")).toBe(false);
    await reconciler.reconcile();
    expect(fake.hostAllowed("a.example.com")).toBe(true);

    // The block is never absent: a failure between the copy and the delete leaves two blocks, not none.
    await withCatalog(db, [mcp("a", "https://a.example.com/"), mcp("c", "https://c.example.com/")]);
    const del = fake.fetch;
    let blockDeletes = 0;
    const flaky = new OneCliAdmin(
      "http://onecli:10256",
      new Redacted("oc_admin"),
      (url, init) => {
        if (
          init.method === "DELETE" &&
          new URL(url).pathname.includes("/rules/") &&
          blockDeletes++ === 0
        ) {
          return Promise.reject(new Error("network"));
        }
        return del(url, init);
      },
      { timeoutMs: 1000, retries: 0, backoffMs: 1, maxBackoffMs: 1 },
    );
    const failing = new HostRuleReconciler({ pool: db.asPool(), onecli: flaky, now: () => NOW });
    await expect(failing.reconcile()).rejects.toThrow();
    expect(fake.hostRules.filter((r) => r.action === "block").length).toBeGreaterThanOrEqual(1);
    expect(fake.hostAllowed("never.example.com")).toBe(false);
    // The next pass finishes the job.
    await reconciler.reconcile();
    expect(fake.hostRules.filter((r) => r.action === "block")).toHaveLength(1);
    expect(fake.hostAllowed("c.example.com")).toBe(true);
  });

  it("skips a pass while another orchestrator holds the lock", async () => {
    const { fake, db } = setUp();
    const pool = db.asPool();
    const busy = {
      query: pool.query.bind(pool),
      connect: () =>
        Promise.resolve({
          query: () => Promise.resolve({ rows: [{ locked: false }] }),
          release: () => undefined,
        }),
    } as unknown as pg.Pool;
    const onecli = new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), fake.fetch);
    expect(await new HostRuleReconciler({ pool: busy, onecli }).reconcile()).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});
