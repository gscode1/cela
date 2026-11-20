import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, seedSettings } from "@cela/session-core";
import type { Settings } from "@cela/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

// The browser flavour on the session API and the admin API (issue #48, docs/decisions/0041-browser-sandbox.md).

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

async function start(browserFlavourEnabled: boolean, shared?: FakeSettingsDb) {
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
    browserFlavourEnabled,
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
const browser = { definition: { sandboxFlavour: "browser" } };

describe("sandbox flavours", () => {
  it("a session is default by default, and says so", async () => {
    const { base, db } = await start(false);
    const created = await json(await call(base, "bob", "POST", "/sessions", {}));
    expect(created.sandboxFlavour).toBe("default");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.sandbox_flavour).toBe("default");
  });

  it("refuses a browser profile when the chart does not enable the flavour", async () => {
    const { base } = await start(false);
    const put = await call(base, "alice", "PUT", "/admin/profiles/web", browser);
    expect(put.status).toBe(400);
    expect((await json(put)).error).toMatch(/sandbox\.flavours\.browser\.enabled/);
  });

  it("refuses a session of a stored browser profile once the flavour is switched off", async () => {
    const on = await start(true);
    expect((await call(on.base, "alice", "PUT", "/admin/profiles/web", browser)).status).toBe(201);
    const off = await start(false, on.db);
    const refused = await call(off.base, "bob", "POST", "/sessions", { profile: "web" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/sandbox\.flavours\.browser\.enabled/);
  });

  it("with the flavour: stores browser on the session and reports it", async () => {
    const { base, db } = await start(true);
    expect((await call(base, "alice", "PUT", "/admin/profiles/web", browser)).status).toBe(201);
    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "web" }));
    expect(created.sandboxFlavour).toBe("browser");
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.sandbox_flavour).toBe("browser");
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).sandboxFlavour).toBe(
      "browser",
    );
  });

  it("refuses a browser session with a repo", async () => {
    const { base } = await start(true);
    await call(base, "alice", "PUT", "/admin/profiles/web", browser);
    const refused = await call(base, "bob", "POST", "/sessions", { profile: "web", repo: "o/r" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/cannot be combined with a repo/);
  });

  it("refuses a browser profile with a credentialed MCP server", async () => {
    const { base } = await start(true);
    const server = await call(base, "alice", "PUT", "/admin/mcp-servers/crm", {
      url: "https://crm.example.com/mcp",
      readOnly: true,
      onecliSecret: "crm-token",
    });
    expect(server.status).toBe(201);
    const refused = await call(base, "alice", "PUT", "/admin/profiles/web", {
      definition: { sandboxFlavour: "browser", mcpServers: ["crm"] },
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(
      /sandboxFlavour browser cannot be combined with the credentialed MCP server "crm"/,
    );
  });

  it("refuses a browser profile while a onecli rule applies to it (github.com gets no injection)", async () => {
    const { base, db } = await start(true);
    const audit = {
      revision: 1,
      created_at: "2026-11-18T00:00:00Z",
      created_by: "alice",
      updated_at: "2026-11-18T00:00:00Z",
      updated_by: "alice",
    };
    db.egressRows = {
      rule_sets: [{ ...audit, name: "everywhere", description: "", applies_to_all: true }],
      rules: [
        {
          ...audit,
          id: 1,
          rule_set: "everywhere",
          session_id: null,
          effect: "allow",
          host: "github.com",
          ports: [443],
          route: "onecli",
          allows_private: false,
          expires_at: null,
          note: "",
        },
      ],
    };
    const refused = await call(base, "alice", "PUT", "/admin/profiles/web", browser);
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/route onecli rule for "github\.com"/);
  });

  it("rejects an unknown flavour", async () => {
    const { base } = await start(true);
    const put = await call(base, "alice", "PUT", "/admin/profiles/odd", {
      definition: { sandboxFlavour: "gpu" },
    });
    expect(put.status).toBe(400);
    expect((await json(put)).error).toBe("sandboxFlavour must be one of default, browser");
  });

  it("lists the flavours for admins: browser only when enabled", async () => {
    const off = await start(false);
    expect(await json(await call(off.base, "alice", "GET", "/admin/sandbox-flavours"))).toEqual({
      flavours: ["default"],
      defaultFlavour: "default",
      browserEnabled: false,
    });
    expect((await call(off.base, "bob", "GET", "/admin/sandbox-flavours")).status).toBe(403);
    const on = await start(true);
    expect(
      (await json(await call(on.base, "alice", "GET", "/admin/sandbox-flavours"))).flavours,
    ).toEqual(["default", "browser"]);
  });
});
