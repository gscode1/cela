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
  settings: Settings = seed,
): Promise<{ base: string; db: FakeSettingsDb }> {
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), settings);
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

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const RESEARCH = { tools: ["read"], instructions: "Only read.", mcpServers: ["demo"] };

/** The catalog has `demo`, so profiles may name it. */
function addDemoServer(db: FakeSettingsDb): void {
  db.mcp.set("demo", {
    name: "demo",
    url: "https://mcp.example.com/mcp",
    transport: "streamable-http",
    enabled: true,
    read_only: true,
    timeout_ms: 60_000,
    max_output_bytes: 24_576,
    onecli_secret: null,
    created_at: new Date(0),
    created_by: "alice",
    updated_at: new Date(0),
    updated_by: "alice",
  });
}

describe("admin profiles authorization", () => {
  it("answers 401 without a token and 403 to a non-admin on every route, and nothing is written", async () => {
    const { base, db } = await start();
    const routes: [string, string, unknown?][] = [
      ["GET", "/admin/profiles"],
      ["GET", "/admin/profiles/coding"],
      ["PUT", "/admin/profiles/research", { definition: {} }],
      ["DELETE", "/admin/profiles/coding"],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(base, undefined, method, path, body)).status, `${method} ${path}`).toBe(
        401,
      );
      expect((await call(base, "bob", method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(db.profiles.size).toBe(1);
    expect(db.versions).toHaveLength(1);
  });
});

describe("admin profiles", () => {
  it("lists the seeded coding profile with the default profile name", async () => {
    const { base } = await start();
    const list = (await json(await call(base, "alice", "GET", "/admin/profiles"))) as {
      defaultProfile: string;
      profiles: { name: string; currentVersion: number; definition: unknown }[];
    };
    expect(list.defaultProfile).toBe("coding");
    expect(list.profiles).toMatchObject([{ name: "coding", currentVersion: 1, definition: {} }]);
  });

  it("creates with 201, a changed definition makes version 2, an identical one is a no-op, and GET lists the versions", async () => {
    const { base, db } = await start();
    addDemoServer(db);
    const created = await call(base, "alice", "PUT", "/admin/profiles/research", {
      definition: RESEARCH,
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "research",
      currentVersion: 1,
      enabledForNew: true,
      definition: RESEARCH,
      versionCreated: true,
      createdBy: "alice",
    });

    const same = await call(base, "bob2", "PUT", "/admin/profiles/research", {
      definition: { mcpServers: ["demo"], instructions: "Only read.", tools: ["read"] },
    });
    // bob2 is not an admin: nothing changes.
    expect(same.status).toBe(403);

    const noop = await call(base, "alice", "PUT", "/admin/profiles/research", {
      definition: { mcpServers: ["demo"], instructions: "Only read.", tools: ["read"] },
    });
    expect(noop.status).toBe(200);
    expect(await noop.json()).toMatchObject({ currentVersion: 1, versionCreated: false });

    const changed = await call(base, "alice", "PUT", "/admin/profiles/research", {
      definition: { ...RESEARCH, turnBudget: 9 },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ currentVersion: 2, versionCreated: true });

    const got = (await json(await call(base, "alice", "GET", "/admin/profiles/research"))) as {
      currentVersion: number;
      versions: { version: number; createdBy: string; definition: { turnBudget?: number } }[];
    };
    expect(got.currentVersion).toBe(2);
    expect(got.versions.map((v) => [v.version, v.definition.turnBudget])).toEqual([
      [2, 9],
      [1, undefined],
    ]);
    expect((await call(base, "alice", "GET", "/admin/profiles/missing")).status).toBe(404);
  });

  it("enabledForNew toggles without a version; DELETE is not offered", async () => {
    const { base } = await start();
    await call(base, "alice", "PUT", "/admin/profiles/research", { definition: {} });
    const off = await call(base, "alice", "PUT", "/admin/profiles/research", {
      enabledForNew: false,
    });
    expect(await off.json()).toMatchObject({
      enabledForNew: false,
      currentVersion: 1,
      versionCreated: false,
    });
    expect((await call(base, "alice", "DELETE", "/admin/profiles/research")).status).toBe(405);
  });

  it("answers 400 for bad input, unknown tools, an MCP server not in the catalog, and writes nothing", async () => {
    const { base, db } = await start();
    const bad: [string, unknown, RegExp][] = [
      ["research", { definition: { tools: ["grep"] } }, /not an installed tool/],
      ["research", { definition: { mcpServers: ["demo"] } }, /not in the MCP catalog/],
      ["research", { definition: { turnBudget: 0 } }, /turnBudget/],
      ["research", { definition: { extra: 1 } }, /unknown field/],
      ["research", { extra: 1 }, /unknown field/],
      ["research", {}, /definition, enabledForNew or both/],
      ["research", { enabledForNew: false }, /definition is required/],
      ["Bad_Name", { definition: {} }, /profile name must match/],
    ];
    for (const [name, body, message] of bad) {
      const response = await call(base, "alice", "PUT", `/admin/profiles/${name}`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(message);
    }
    expect(db.profiles.size).toBe(1);
  });

  it("checks tools against what the orchestrator published, not the built-in names, once it has", async () => {
    const { base, db } = await start();
    expect(
      (await call(base, "alice", "PUT", "/admin/profiles/a", { definition: { tools: ["bash"] } }))
        .status,
    ).toBe(201);
    db.capabilities = { tools: ["read", "grep"], extensions: ["coding-tools"], instance: "o" };
    expect(
      (await call(base, "alice", "PUT", "/admin/profiles/b", { definition: { tools: ["bash"] } }))
        .status,
    ).toBe(400);
    expect(
      (await call(base, "alice", "PUT", "/admin/profiles/b", { definition: { tools: ["grep"] } }))
        .status,
    ).toBe(201);
  });

  it("settings: defaultProfile must exist and be enabled for new sessions", async () => {
    const { base } = await start();
    const put = (defaultProfile: unknown) =>
      call(base, "alice", "PUT", "/admin/settings", { defaultProfile });
    expect((await put("nope")).status).toBe(400);
    expect((await put("Bad Name")).status).toBe(400);
    await call(base, "alice", "PUT", "/admin/profiles/research", { definition: {} });
    expect((await put("research")).status).toBe(200);
    expect((await put("coding")).status).toBe(200);
    await call(base, "alice", "PUT", "/admin/profiles/research", { enabledForNew: false });
    expect((await put("research")).status).toBe(400);
    expect((await put("coding")).status).toBe(200);
    expect(await json(await call(base, "alice", "GET", "/admin/settings"))).toMatchObject({
      defaultProfile: "coding",
    });
  });
});

describe("POST /sessions with profiles", () => {
  const post = (base: string, body: unknown = {}) => call(base, "bob", "POST", "/sessions", body);

  it("without `profile` the default applies and is echoed; the snapshot is stored with name and version", async () => {
    const { base, db } = await start();
    const created = await json(await post(base));
    expect(created.profile).toEqual({ name: "coding", version: 1 });
    const row = db.sessions.get(String(created.sessionId));
    expect(row).toMatchObject({
      profile_name: "coding",
      profile_version: 1,
      profile_snapshot: {},
    });
    const got = await json(
      await call(base, "bob", "GET", `/sessions/${String(created.sessionId)}`),
    );
    expect(got.profile).toEqual({ name: "coding", version: 1 });
  });

  it("a named profile is snapshotted at its current version; editing or disabling it later changes nothing for the session", async () => {
    const { base, db } = await start();
    addDemoServer(db);
    await call(base, "alice", "PUT", "/admin/profiles/research", { definition: RESEARCH });
    const created = await json(await post(base, { profile: "research" }));
    expect(created.profile).toEqual({ name: "research", version: 1 });
    const id = String(created.sessionId);
    expect(db.sessions.get(id)?.profile_snapshot).toEqual(RESEARCH);

    await call(base, "alice", "PUT", "/admin/profiles/research", {
      definition: { tools: ["read", "bash"] },
    });
    await call(base, "alice", "PUT", "/admin/profiles/research", { enabledForNew: false });
    expect(db.sessions.get(id)?.profile_snapshot).toEqual(RESEARCH);
    expect(db.sessions.get(id)?.profile_version).toBe(1);
    const got = await json(await call(base, "bob", "GET", `/sessions/${id}`));
    expect(got.profile).toEqual({ name: "research", version: 1 });

    // New sessions: refused while disabled, version 2 once enabled again.
    expect((await post(base, { profile: "research" })).status).toBe(400);
    await call(base, "alice", "PUT", "/admin/profiles/research", { enabledForNew: true });
    expect((await json(await post(base, { profile: "research" }))).profile).toEqual({
      name: "research",
      version: 2,
    });
  });

  it("an unknown, disabled or malformed profile is 400 and creates no session", async () => {
    const { base, db } = await start();
    await call(base, "alice", "PUT", "/admin/profiles/off", {
      definition: {},
      enabledForNew: false,
    });
    for (const profile of ["nope", "off", "Bad Name", 3, null, ""]) {
      const response = await post(base, { profile });
      expect(response.status, String(profile)).toBe(400);
    }
    expect(db.sessions.size).toBe(0);
  });

  it("a default profile that is gone or disabled fails closed with 503, never another profile", async () => {
    const { base, db } = await start(["alice"], { ...seed, defaultProfile: "research" });
    const response = await post(base);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /default profile "research" does not exist/,
    );
    await call(base, "alice", "PUT", "/admin/profiles/research", { definition: {} });
    expect((await post(base)).status).toBe(201);
    // The API no longer lets the default be disabled (ADR 0023); a row edited by hand still fails closed.
    const row = db.profiles.get("research");
    if (row !== undefined) row.enabled_for_new = false;
    expect((await post(base)).status).toBe(503);
    expect(db.sessions.size).toBe(1);
  });

  it("an invalid stored profile (edited by hand) is refused, not applied in part", async () => {
    const { base, db } = await start();
    await call(base, "alice", "PUT", "/admin/profiles/research", { definition: RESEARCH_PLAIN });
    const version = db.versions.find((v) => v.name === "research");
    if (version !== undefined) version.definition = { tools: "read" };
    expect((await post(base, { profile: "research" })).status).toBe(400);
  });

  it("model and reasoning: the request beats the profile, the profile beats the settings, all checked at creation", async () => {
    const { base } = await start(["alice"], { ...seed, reasoning: "low" });
    await call(base, "alice", "PUT", "/admin/profiles/deep", {
      definition: { defaultModel: "scripted/scripted-2", reasoning: "high" },
    });
    // Settings only.
    expect(await json(await post(base))).toMatchObject({ model: "scripted-1", reasoning: "low" });
    // Profile over settings.
    expect(await json(await post(base, { profile: "deep" }))).toMatchObject({
      model: "scripted-2",
      reasoning: "high",
    });
    // Request over profile, field by field.
    expect(
      await json(await post(base, { profile: "deep", provider: "scripted", model: "scripted-1" })),
    ).toMatchObject({ model: "scripted-1", reasoning: "high" });
    expect(await json(await post(base, { profile: "deep", reasoning: "off" }))).toMatchObject({
      model: "scripted-2",
      reasoning: "off",
    });

    // The cap applies to the profile's reasoning; a request below the cap still works.
    await call(base, "alice", "PUT", "/admin/settings", {
      reasoning: null,
      maxReasoning: "medium",
    });
    const capped = await post(base, { profile: "deep" });
    expect(capped.status).toBe(400);
    expect(((await capped.json()) as { error: string }).error).toMatch(
      /profile "deep" v1: reasoning high is above the allowed maximum medium/,
    );
    expect((await post(base, { profile: "deep", reasoning: "medium" })).status).toBe(201);

    // The allowlist applies to the profile's model.
    await call(base, "alice", "PUT", "/admin/settings", {
      maxReasoning: null,
      allowlist: ["scripted/scripted-1"],
    });
    const gone = await post(base, { profile: "deep" });
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { error: string }).error).toMatch(/not allowed/);
    expect(
      (await post(base, { profile: "deep", provider: "scripted", model: "scripted-1" })).status,
    ).toBe(201);
  });

  it("a session without a stored profile (created before profiles) is reported as coding v1", async () => {
    const { base, db } = await start();
    const id = "11111111-2222-4333-8444-555555555555";
    db.sessions.set(id, {
      id,
      owner: "bob",
      owner_subject: "static:bob",
      status: "active",
      conversation_id: null,
      model_provider: null,
      model_id: null,
      model_reasoning: null,
      failure: null,
      repo: null,
      repo_branch: null,
      onecli_agent_id: null,
      onecli_secret_ids: null,
      workspace_ready_at: null,
      profile_name: null,
      profile_version: null,
      profile_snapshot: null,
      created_at: new Date(),
      last_activity_at: new Date(),
    });
    const got = await json(await call(base, "bob", "GET", `/sessions/${id}`));
    expect(got.profile).toEqual({ name: "coding", version: 1 });
  });
});

const RESEARCH_PLAIN = { tools: ["read"] };
