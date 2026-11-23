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

async function start(
  browserFlavourEnabled: boolean,
  shared?: FakeSettingsDb,
  desktopFlavourEnabled = false,
  sessionMailServer?: string,
) {
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
    desktopFlavourEnabled,
    sessionMailServer,
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

  it("lets a browser profile name the configured session mail server, and no other credentialed one (ADR 0066)", async () => {
    const { base, db } = await start(true, undefined, true, "mail");
    for (const name of ["mail", "crm"]) {
      const put = await call(base, "alice", "PUT", `/admin/mcp-servers/${name}`, {
        url: `https://${name}.example.com/mcp`,
        readOnly: true,
        onecliSecret: `${name}-token`,
      });
      expect(put.status).toBe(201);
    }
    const profile = (servers: string[], flavour = "browser") => ({
      definition: { sandboxFlavour: flavour, mcpServers: servers },
    });
    expect(
      (await call(base, "alice", "PUT", "/admin/profiles/web", profile(["mail"]))).status,
    ).toBe(201);
    const created = await call(base, "bob", "POST", "/sessions", { profile: "web" });
    expect(created.status).toBe(201);
    expect(db.sessions.size).toBe(1);
    const other = await call(base, "alice", "PUT", "/admin/profiles/crm", profile(["mail", "crm"]));
    expect(other.status).toBe(400);
    expect((await json(other)).error).toMatch(/credentialed MCP server "crm"/);
    const desktop = await call(
      base,
      "alice",
      "PUT",
      "/admin/profiles/desk",
      profile(["mail"], "desktop"),
    );
    expect(desktop.status).toBe(400);
    expect((await json(desktop)).error).toMatch(/sandboxFlavour desktop cannot be combined/);
  });

  it("refuses the credential on the mail server for a browser profile when no mail server is configured", async () => {
    const { base } = await start(true);
    await call(base, "alice", "PUT", "/admin/mcp-servers/mail", {
      url: "https://mail.example.com/mcp",
      readOnly: true,
    });
    expect(
      (
        await call(base, "alice", "PUT", "/admin/profiles/web", {
          definition: { sandboxFlavour: "browser", mcpServers: ["mail"] },
        })
      ).status,
    ).toBe(201);
    const secret = await call(base, "alice", "PUT", "/admin/mcp-servers/mail", {
      onecliSecret: "mail-token",
    });
    expect(secret.status).toBe(400);
    expect((await json(secret)).error).toMatch(/web \(sandboxFlavour browser\)/);
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
    expect((await json(put)).error).toBe("sandboxFlavour must be one of default, browser, desktop");
  });

  it("lists the flavours for admins: browser only when enabled", async () => {
    const off = await start(false);
    expect(await json(await call(off.base, "alice", "GET", "/admin/sandbox-flavours"))).toEqual({
      flavours: ["default"],
      defaultFlavour: "default",
      browserEnabled: false,
      desktopEnabled: false,
    });
    expect((await call(off.base, "bob", "GET", "/admin/sandbox-flavours")).status).toBe(403);
    const on = await start(true);
    expect(
      (await json(await call(on.base, "alice", "GET", "/admin/sandbox-flavours"))).flavours,
    ).toEqual(["default", "browser"]);
  });

  it("lists desktop when it is enabled", async () => {
    const on = await start(false, undefined, true);
    expect(await json(await call(on.base, "alice", "GET", "/admin/sandbox-flavours"))).toEqual({
      flavours: ["default", "desktop"],
      defaultFlavour: "default",
      browserEnabled: false,
      desktopEnabled: true,
    });
  });
});

// ADR 0065: the desktop flavour has the same credential rules as the browser one.
const desktop = { definition: { sandboxFlavour: "desktop" } };

describe("the desktop sandbox flavour", () => {
  it("refuses a desktop profile when the chart does not enable the flavour", async () => {
    const { base } = await start(true);
    const put = await call(base, "alice", "PUT", "/admin/profiles/desk", desktop);
    expect(put.status).toBe(400);
    expect((await json(put)).error).toMatch(/sandbox\.flavours\.desktop\.enabled/);
  });

  it("refuses a session of a stored desktop profile once the flavour is switched off", async () => {
    const on = await start(false, undefined, true);
    expect((await call(on.base, "alice", "PUT", "/admin/profiles/desk", desktop)).status).toBe(201);
    const off = await start(true, on.db);
    const refused = await call(off.base, "bob", "POST", "/sessions", { profile: "desk" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(/sandbox\.flavours\.desktop\.enabled/);
  });

  it("with the flavour: stores desktop on the session and reports it", async () => {
    const { base, db } = await start(false, undefined, true);
    expect((await call(base, "alice", "PUT", "/admin/profiles/desk", desktop)).status).toBe(201);
    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "desk" }));
    expect(created.sandboxFlavour).toBe("desktop");
    expect(db.sessions.get(String(created.sessionId))?.sandbox_flavour).toBe("desktop");
  });

  it("refuses a desktop session with a repo", async () => {
    const { base } = await start(false, undefined, true);
    await call(base, "alice", "PUT", "/admin/profiles/desk", desktop);
    const refused = await call(base, "bob", "POST", "/sessions", { profile: "desk", repo: "o/r" });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(
      /sandboxFlavour desktop cannot be combined with a repo/,
    );
  });

  it("refuses a desktop profile with a credentialed MCP server", async () => {
    const { base } = await start(false, undefined, true);
    const server = await call(base, "alice", "PUT", "/admin/mcp-servers/crm", {
      url: "https://crm.example.com/mcp",
      readOnly: true,
      onecliSecret: "crm-token",
    });
    expect(server.status).toBe(201);
    const refused = await call(base, "alice", "PUT", "/admin/profiles/desk", {
      definition: { sandboxFlavour: "desktop", mcpServers: ["crm"] },
    });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatch(
      /sandboxFlavour desktop cannot be combined with the credentialed MCP server "crm"/,
    );
  });
});
