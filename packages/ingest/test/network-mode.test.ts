import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, seedSettings } from "@pi-durable-k8s/session-core";
import type { Settings } from "@pi-durable-k8s/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

// Network modes on the session API and the admin API (issue #47, docs/decisions/0038-network-modes.md).

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

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(allowDirectSandboxEgress: boolean, shared?: FakeSettingsDb) {
  const db = shared ?? new FakeSettingsDb();
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
    allowDirectSandboxEgress,
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
const direct = { definition: { networkMode: "direct" } };

describe("network modes", () => {
  it("a session is proxied by default, and says so", async () => {
    const { base, db } = await start(false);
    const created = await json(await call(base, "bob", "POST", "/sessions", {}));
    expect(created.networkMode).toBe("proxied");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.network_mode).toBe("proxied");
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).networkMode).toBe(
      "proxied",
    );
  });

  it("refuses a direct profile without the chart gate, with a clear 400", async () => {
    const { base } = await start(false);
    const put = await call(base, "alice", "PUT", "/admin/profiles/open", direct);
    expect(put.status).toBe(400);
    expect((await json(put)).error).toMatch(/security\.allowDirectSandboxEgress/);
  });

  it("refuses a session of a direct profile that predates the gate being switched off", async () => {
    const on = await start(true);
    expect((await call(on.base, "alice", "PUT", "/admin/profiles/open", direct)).status).toBe(201);
    // The same database, gate off: the stored profile stays, new sessions of it are a 400.
    const off = await start(false, on.db);
    const refused = await call(off.base, "bob", "POST", "/sessions", { profile: "open" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/allowDirectSandboxEgress/);
  });

  it("with the gate: stores direct on the session, reports it and counts it", async () => {
    const { base, db } = await start(true);
    expect((await call(base, "alice", "PUT", "/admin/profiles/open", direct)).status).toBe(201);
    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "open" }));
    expect(created.networkMode).toBe("direct");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.network_mode).toBe("direct");
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).networkMode).toBe(
      "direct",
    );
    const status = await json(await call(base, "alice", "GET", "/admin/status"));
    expect(status.directSessions).toBe(1);
  });

  it("refuses a direct session with a repo", async () => {
    const { base } = await start(true);
    await call(base, "alice", "PUT", "/admin/profiles/open", direct);
    const refused = await call(base, "bob", "POST", "/sessions", {
      profile: "open",
      repo: "o/r",
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/cannot be combined with a repo/);
  });

  it("refuses direct together with a credentialed MCP server", async () => {
    const { base } = await start(true);
    const server = await call(base, "alice", "PUT", "/admin/mcp-servers/crm", {
      url: "https://crm.example.com/mcp",
      readOnly: true,
      onecliSecret: "crm-token",
    });
    expect(server.status).toBe(201);
    const refused = await call(base, "alice", "PUT", "/admin/profiles/open", {
      definition: { networkMode: "direct", mcpServers: ["crm"] },
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/credentialed MCP server "crm"/);
  });

  it("refuses direct while a onecli rule applies to the profile, and allows it when none does", async () => {
    const { base, db } = await start(true);
    const audit = {
      revision: 1,
      created_at: "2026-11-18T00:00:00Z",
      created_by: "alice",
      updated_at: "2026-11-18T00:00:00Z",
      updated_by: "alice",
    };
    const rule = (id: number, ruleSet: string, route: string) => ({
      ...audit,
      id,
      rule_set: ruleSet,
      session_id: null,
      effect: "allow",
      host: "github.com",
      ports: [443],
      route,
      allows_private: false,
      expires_at: null,
      note: "",
    });
    const set = (name: string, all: boolean) => ({
      ...audit,
      name,
      description: "",
      applies_to_all: all,
    });
    db.egressRows = {
      rule_sets: [set("everywhere", true), set("named", false), set("plain", false)],
      rules: [
        rule(1, "everywhere", "onecli"),
        rule(2, "named", "onecli"),
        rule(3, "plain", "direct"),
      ],
    };
    db.egressRuleSets = new Set(["everywhere", "named", "plain"]);
    const all = await call(base, "alice", "PUT", "/admin/profiles/open", direct);
    expect(all.status).toBe(400);
    expect((await json(all)).error).toMatch(
      /route onecli rule for "github\.com" in rule set "everywhere"/,
    );
    // Only the sets that apply count: drop the one that applies to all, name the other.
    db.egressRows.rules = [rule(2, "named", "onecli"), rule(3, "plain", "direct")];
    db.egressRows.rule_sets = [set("everywhere", true), set("named", false), set("plain", false)];
    const named = await call(base, "alice", "PUT", "/admin/profiles/open", {
      definition: { networkMode: "direct", egressRuleSets: ["named"] },
    });
    expect(named.status).toBe(400);
    const plain = await call(base, "alice", "PUT", "/admin/profiles/open", {
      definition: { networkMode: "direct", egressRuleSets: ["plain"] },
    });
    expect(plain.status).toBe(201);
  });

  it("rejects an unknown network mode", async () => {
    const { base } = await start(true);
    const put = await call(base, "alice", "PUT", "/admin/profiles/odd", {
      definition: { networkMode: "bridged" },
    });
    expect(put.status).toBe(400);
    expect((await json(put)).error).toBe("networkMode must be one of proxied, direct");
  });

  it("lists the modes for admins: direct only with the gate", async () => {
    const off = await start(false);
    expect(await json(await call(off.base, "alice", "GET", "/admin/network-modes"))).toEqual({
      modes: ["proxied"],
      defaultMode: "proxied",
      directAllowed: false,
    });
    expect((await call(off.base, "bob", "GET", "/admin/network-modes")).status).toBe(403);
    const on = await start(true);
    expect((await json(await call(on.base, "alice", "GET", "/admin/network-modes"))).modes).toEqual(
      ["proxied", "direct"],
    );
  });
});
