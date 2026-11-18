import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TOOL_NAMES } from "@pi-durable-k8s/session-core";
import type { InboxEvent, ProfileDefinition, SessionRow } from "@pi-durable-k8s/session-core";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";
import { publishAndCheckProfiles } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { TOKEN_BUDGET_EXHAUSTED } from "../src/failure.ts";
import { definitionOf, PermanentError, SessionService } from "../src/sessions.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
  PI_SESSION_TURN_BUDGET: "100",
});
const MODEL = { provider: "scripted", model: "scripted-1" } as const;

const hosts: Host[] = [];
async function openHost(): Promise<Host> {
  const host = await Host.open(
    new MemoryStorage(),
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
  );
  hosts.push(host);
  return host;
}
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  vi.restoreAllMocks();
});

const session = (profile: SessionRow["profile"], conversationId: number | null): SessionRow => ({
  id: "s1",
  owner: "alice",
  ownerSubject: "static:alice",
  status: "active",
  shard: 0,
  conversationId,
  model: MODEL,
  failure: null,
  repo: null,
  onecli: null,
  workspaceReadyAt: null,
  profile,
  usage: null,
  sandboxSize: null,
  networkMode: "proxied",
  sandboxFlavour: "default",
  createdAt: new Date(),
  lastActivityAt: new Date(),
});

const message = (text: string, id: string): InboxEvent => ({
  id,
  sessionId: "s1",
  source: "api:alice",
  sourceEventId: id,
  kind: "message",
  payload: { text },
  status: "pending",
  attempts: 0,
  createdAt: new Date(),
  submittedAt: null,
  error: null,
});

describe("Host: the profile decides tools and instructions", () => {
  it("two conversations with different profiles get different offered tools and instructions", async () => {
    const host = await openHost();
    const plain = await host.createConversation(MODEL);
    const readOnly = await host.createConversation(MODEL, {
      tools: ["read"],
      instructions: "Only read; never edit.",
    });
    const split = await host.createConversation(MODEL, {
      tools: ["read", "bash"],
      modelTools: ["read"],
      instructions: "Second profile.",
    });
    expect(await host.toolsOf(plain)).toEqual({
      offered: ["read", "write", "edit", "bash"],
      deferred: [],
    });
    expect((await host.toolsOf(readOnly)).offered).toEqual(["read"]);
    expect((await host.toolsOf(split)).offered).toEqual(["read"]);
    expect(await host.instructionsOf(plain)).toBeUndefined();
    expect(await host.instructionsOf(readOnly)).toBe("Only read; never edit.");
    expect(await host.instructionsOf(split)).toBe("Second profile.");
  });

  it("an empty tools list leaves a session with no coding tools, and an unknown tool name never widens it", async () => {
    const host = await openHost();
    const none = await host.createConversation(MODEL, { tools: [] });
    const unknown = await host.createConversation(MODEL, { tools: ["grep"] });
    expect((await host.toolsOf(none)).offered).toEqual([]);
    expect((await host.toolsOf(unknown)).offered).toEqual([]);
  });

  it("MCP servers in the profile add tool_search; none means no tool_search at all", async () => {
    const host = await openHost();
    const mcp = await host.createConversation(MODEL, { tools: ["read"], mcpServers: ["demo"] });
    const none = await host.createConversation(MODEL, { tools: ["read"] });
    expect((await host.toolsOf(mcp)).offered).toEqual(["read", "tool_search"]);
    expect((await host.toolsOf(none)).offered).toEqual(["read"]);
  });

  it("publishes the installed tool names, which equal session-core's built-in list", async () => {
    const host = await openHost();
    expect(host.capabilities().tools).toEqual([...BUILTIN_TOOL_NAMES]);
  });
});

describe("definitionOf", () => {
  it("a session without a profile is coding v1: the empty definition", () => {
    expect(definitionOf(session(null, null))).toEqual({});
  });

  it("validates the snapshot and refuses one that was edited into something invalid", () => {
    const ok = session(
      { name: "r", version: 2, snapshot: { turnBudget: 3, tools: ["read"] } },
      null,
    );
    expect(definitionOf(ok)).toEqual({ tools: ["read"], turnBudget: 3 });
    for (const snapshot of [{ tools: "read" }, { admin: true }, null, "x"]) {
      expect(() => definitionOf(session({ name: "r", version: 1, snapshot }, null))).toThrow(
        PermanentError,
      );
    }
  });
});

describe("SessionService with profiles", () => {
  function service(host: Host, turnBudget = 100, tokenBudget: number | null = null) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as pg.Pool;
    return {
      queries,
      service: new SessionService(pool, host, {
        shard: 0,
        testFaults: false,
        defaultModel: config.models.default,
        turnBudget: () => turnBudget,
        tokenBudget: () => tokenBudget,
      }),
    };
  }

  it("creates the conversation from the session row's snapshot, not from anything live; a legacy session gets {}", async () => {
    const created: [unknown, ProfileDefinition][] = [];
    const host = {
      createConversation: (model: unknown, definition: ProfileDefinition) => {
        created.push([model, definition]);
        return Promise.resolve(created.length);
      },
    } as unknown as Host;
    const snapshot = { tools: ["read"], instructions: "v1" };
    const row = { ...session({ name: "research", version: 1, snapshot }, null) };
    const fake = new FakeSettingsDb();
    // The database holds the session row, as the service reads it again before creating.
    fake.sessions.set("s1", {
      id: "s1",
      owner: "alice",
      owner_subject: "static:alice",
      status: "active",
      conversation_id: null,
      model_provider: "scripted",
      model_id: "scripted-1",
      model_reasoning: null,
      failure: null,
      repo: null,
      repo_branch: null,
      onecli_agent_id: null,
      onecli_secret_ids: null,
      workspace_ready_at: null,
      profile_name: "research",
      profile_version: 1,
      profile_snapshot: snapshot,
      created_at: new Date(),
      last_activity_at: new Date(),
    });
    const svc = new SessionService(fake.asPool(), host, {
      shard: 0,
      testFaults: false,
      defaultModel: config.models.default,
      turnBudget: () => 100,
    });
    // `update inbox.sessions set conversation_id` is not part of the fake: let it through.
    const query = fake.query.bind(fake);
    fake.query = (sql, params) =>
      sql.startsWith("update inbox.sessions set conversation_id")
        ? Promise.resolve({ rows: [], rowCount: 1 })
        : query(sql, params);
    expect(await svc.ensureConversation(row)).toBe(1);
    expect(created[0]).toEqual([MODEL, snapshot]);

    // The same session with no stored profile (it predates profiles).
    const legacy = fake.sessions.get("s1");
    if (legacy !== undefined)
      Object.assign(legacy, { profile_name: null, profile_version: null, profile_snapshot: null });
    expect(await svc.ensureConversation(session(null, null))).toBe(2);
    expect(created[1]?.[1]).toEqual({});
    svc.stop();
  });

  it("enforces the profile's turn budget instead of the settings'; a legacy session still uses the settings budget", async () => {
    const host = await openHost();
    const { service: svc, queries } = service(host, 100);
    const conversationId = await host.createConversation(MODEL, { turnBudget: 1 });
    const profiled = session(
      { name: "tiny", version: 1, snapshot: { turnBudget: 1 } },
      conversationId,
    );

    await svc.apply(message("one", "1"), profiled);
    for (let i = 0; i < 200 && (await host.turnsUsed(conversationId)) < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);
    await expect(svc.apply(message("two", "2"), profiled)).rejects.toThrow(/turn budget exhausted/);
    expect(queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(true);

    // The same history under a legacy session (settings budget 100) is not exhausted.
    queries.length = 0;
    await svc.apply(message("three", "3"), session(null, conversationId));
    expect(queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);
    svc.stop();
  });

  it("fails a session whose conversation used its token budget, counted from pi.usage (#178)", async () => {
    const host = await openHost();
    const conversationId = await host.createConversation(MODEL);
    expect(await host.tokensUsed(conversationId)).toBe(0);
    const { service: unlimited } = service(host);
    await unlimited.apply(message("one", "1"), session(null, conversationId));
    let state = await host.submissionState(conversationId, "1");
    for (let i = 0; i < 200 && state?.status !== "done"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await host.submissionState(conversationId, "1");
    }
    const used = await host.tokensUsed(conversationId);
    expect(used).toBeGreaterThan(0);
    unlimited.stop();

    // One token of room left: the next input is still admitted.
    const { service: roomy, queries: roomyQueries } = service(host, 100, used + 1);
    await roomy.apply(message("two", "2"), session(null, conversationId));
    expect(roomyQueries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);
    roomy.stop();

    const { service: tight, queries } = service(host, 100, used);
    await expect(tight.apply(message("three", "3"), session(null, conversationId))).rejects.toThrow(
      /token budget exhausted/,
    );
    const failed = queries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failed?.params).toContain(TOKEN_BUDGET_EXHAUSTED);
    expect(await host.submissionState(conversationId, "3")).toBeUndefined();
    tight.stop();
  });

  it("enforces the profile's token budget instead of the settings', in both directions (#184)", async () => {
    const host = await openHost();
    const conversationId = await host.createConversation(MODEL);
    const { service: unlimited } = service(host);
    await unlimited.apply(message("one", "1"), session(null, conversationId));
    let state = await host.submissionState(conversationId, "1");
    for (let i = 0; i < 200 && state?.status !== "done"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await host.submissionState(conversationId, "1");
    }
    const used = await host.tokensUsed(conversationId);
    expect(used).toBeGreaterThan(0);
    unlimited.stop();

    // The settings say exhausted; the profile's larger budget wins.
    const roomy = { name: "roomy", version: 1, snapshot: { tokenBudget: used + 1_000 } };
    const { service: strictSettings, queries: strictQueries } = service(host, 100, used);
    await strictSettings.apply(message("two", "2"), session(roomy, conversationId));
    expect(strictQueries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);
    strictSettings.stop();

    // The settings say no limit; the profile's budget is used up.
    const tight = { name: "tight", version: 1, snapshot: { tokenBudget: used } };
    const { service: noLimit, queries } = service(host, 100, null);
    await expect(
      noLimit.apply(message("three", "3"), session(tight, conversationId)),
    ).rejects.toThrow(/token budget exhausted/);
    expect(queries.find((q) => q.sql.includes("status = 'failed'"))?.params).toContain(
      TOKEN_BUDGET_EXHAUSTED,
    );
    noLimit.stop();
  });

  it("a steer sent mid-run does not count the running run's turns twice (#177)", async () => {
    // `hold` blocks until released, so the steer arrives while round 3 of the run is in progress.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const hold = defineTool<object>({
      name: "hold",
      description: "returns at once twice, then waits to be released",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        calls += 1;
        if (calls === 3) await held;
        return { output: [{ type: "text", text: "ok" }] };
      },
    });
    const host = await Host.open(
      new MemoryStorage(),
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      {},
      [],
      { codingExtension: defineExtension({ name: "coding", tools: [hold] }) },
    );
    hosts.push(host);
    const { service: svc, queries } = service(host);
    const conversationId = await host.createConversation(MODEL, { turnBudget: 6 });
    const profiled = session(
      { name: "six", version: 1, snapshot: { turnBudget: 6 } },
      conversationId,
    );
    const script = (steps: number) =>
      JSON.stringify({
        steps: Array.from({ length: steps }, () => ({ tool: "hold", args: {} })),
        final: "finished",
      });

    await svc.apply(message(script(3), "1"), profiled);
    for (let i = 0; i < 200 && (await host.runTurns(conversationId)) < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await host.runTurns(conversationId)).toBe(3);

    // 3 of 6 used, all by the running run: it may take 3 more rounds. Counting them twice left it 0 and ended it.
    await svc.apply({ ...message(script(2), "2"), kind: "steer" }, profiled);
    release();
    let state = await host.submissionState(conversationId, "2");
    for (let i = 0; i < 400 && state?.status !== "done" && state?.status !== "unanswered"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = await host.submissionState(conversationId, "2");
    }
    expect(state?.status).toBe("done");
    expect((await host.status(conversationId))?.answer).toBe("finished");
    expect(await host.turnsUsed(conversationId)).toBe(6); // 5 rounds and the answer, within the budget of 6
    expect(queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);
    svc.stop();
  });
});

describe("publishAndCheckProfiles", () => {
  it("publishes the capabilities and logs the profiles whose tools do not resolve, without failing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const db = new FakeSettingsDb();
    db.profiles.set("stale", {
      name: "stale",
      current_version: 1,
      enabled_for_new: true,
      created_at: new Date(),
      created_by: "alice",
      updated_at: new Date(),
      updated_by: "alice",
    });
    db.versions.push({
      name: "stale",
      version: 1,
      definition: { tools: ["grep"], mcpServers: ["gone"] },
      created_at: new Date(),
      created_by: "alice",
    });
    const unresolved = await publishAndCheckProfiles(
      db.asPool(),
      { tools: ["read", "bash"], extensions: ["coding-tools"] },
      "o1",
    );
    expect(unresolved).toEqual(["stale"]);
    expect(db.capabilities).toMatchObject({ tools: ["read", "bash"], instance: "o1" });
    await publishAndCheckProfiles(
      db.asPool(),
      {
        tools: [],
        extensions: [],
        models: [{ provider: "scripted", id: "scripted-1", reasoning: false }],
        modelProviders: [{ provider: "scripted", credential: "configured" }],
      },
      "o1",
    );
    expect(db.capabilities).toMatchObject({
      models: [{ provider: "scripted", id: "scripted-1", reasoning: false }],
      model_providers: [{ provider: "scripted", credential: "configured" }],
    });
    const logged = write.mock.calls.map(([line]) => String(line)).join("");
    expect(logged).toContain("profile-unresolved");
    expect(logged).not.toContain("gone");

    // A database error is logged, never thrown: the orchestrator starts regardless.
    db.failReads = true;
    db.query = () => Promise.reject(new Error("down"));
    expect(await publishAndCheckProfiles(db.asPool(), { tools: [], extensions: [] }, "o1")).toEqual(
      [],
    );
  });
});

describe("a tool the profile removed is refused, not only hidden (#181)", () => {
  /** Two tools that record each call; the profile allows only `allowed`. */
  function spyTools(ran: string[], names: readonly string[]) {
    return defineExtension({
      name: "coding",
      tools: names.map((name) =>
        defineTool<object>({
          name,
          description: `records a call to ${name}`,
          parameters: { type: "object", properties: {} },
          execute: () => {
            ran.push(name);
            return Promise.resolve({ output: [{ type: "text", text: `${name} ran` }] });
          },
        }),
      ),
    });
  }
  async function open(
    storage: Parameters<typeof Host.open>[0],
    extension: Extension,
    profiles?: Map<number, ProfileDefinition>,
  ) {
    const host = await Host.open(
      storage,
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      {},
      [],
      {
        codingExtension: extension,
        ...(profiles === undefined
          ? {}
          : { conversationProfiles: () => Promise.resolve(profiles) }),
      },
    );
    hosts.push(host);
    return host;
  }
  /** Asks the scripted model to call `tool`, waits for the answer, and returns the tool result. */
  async function call(host: Host, id: number, tool: string, requestId: string) {
    const script = { steps: [{ tool, args: {} }], final: "answered" };
    await host.submitInput(id, { text: JSON.stringify(script), requestId, steer: false });
    expect(await host.settlement(id, requestId)).toEqual({ status: "done" });
    return (await host.status(id))?.results.at(-1);
  }

  it("a call the model makes to a removed tool settles tool_unavailable and never runs it", async () => {
    const ran: string[] = [];
    const host = await open(new MemoryStorage(), spyTools(ran, ["allowed", "forbidden"]));
    const id = await host.createConversation(MODEL, { tools: ["allowed"] });
    expect((await host.toolsOf(id)).offered).toEqual(["allowed"]);

    expect(await call(host, id, "forbidden", "r1")).toEqual({
      text: expect.stringContaining("not available") as unknown,
      isError: true,
    });
    expect(ran).toEqual([]);
    // The allowed tool still runs, so the refusal is the filter's doing, not a broken session.
    expect(await call(host, id, "allowed", "r2")).toEqual({ text: "allowed ran", isError: false });
    expect(ran).toEqual(["allowed"]);
  }, 10_000);

  it("a tool a later release installs is refused too, once the filters are recomputed at open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-refused-"));
    try {
      const ran: string[] = [];
      const definition = { tools: ["allowed"] };
      const first = await open(
        await openNodeJsonlStorage(dir, context),
        spyTools(ran, ["allowed"]),
      );
      const id = await first.createConversation(MODEL, definition);
      await first.close();

      const second = await open(
        await openNodeJsonlStorage(dir, context),
        spyTools(ran, ["allowed", "extra"]),
        new Map([[id, definition]]),
      );
      expect(await call(second, id, "extra", "r1")).toMatchObject({ isError: true });
      expect(ran).toEqual([]);
    } finally {
      for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("a coding tool installed by a later release", () => {
  const EXTRA = defineTool<object>({
    name: "extra",
    description: "a tool a later release adds",
    parameters: { type: "object", properties: {} },
    execute: () => Promise.resolve({ output: [{ type: "text", text: "x" }] }),
  });
  const withExtra = () => {
    const base = createCodingTools();
    return defineExtension({ name: base.name, tools: [...(base.tools ?? []), EXTRA] });
  };
  async function reopen(
    dir: string,
    extension?: Extension,
    profiles?: Map<number, ProfileDefinition>,
  ) {
    const host = await Host.open(
      await openNodeJsonlStorage(dir, context),
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      {},
      [],
      {
        ...(extension === undefined ? {} : { codingExtension: extension }),
        ...(profiles === undefined
          ? {}
          : { conversationProfiles: () => Promise.resolve(profiles) }),
      },
    );
    hosts.push(host);
    return host;
  }

  it("is not offered to a session whose profile allows only some tools: recomputed at the next input and at open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tools-"));
    try {
      const definition = { tools: ["read"] };
      const first = await reopen(dir);
      const id = await first.createConversation(MODEL, definition);
      const plain = await first.createConversation(MODEL);
      await first.close();

      // The new release without recomputing: the stored remove list does not know "extra", so it widens.
      const second = await reopen(dir, withExtra());
      expect((await second.toolsOf(id)).offered).toEqual(["read", "extra"]);
      // The input path recomputes it.
      await second.applyProfileTools(id, definition);
      expect((await second.toolsOf(id)).offered).toEqual(["read"]);
      // A session without a restriction (the empty definition) is meant to get every installed coding tool.
      expect((await second.toolsOf(plain)).offered).toContain("extra");
      await second.close();

      // Opening recomputes it too, before runs resume.
      const third = await reopen(dir, withExtra(), new Map([[id, definition]]));
      expect((await third.toolsOf(id)).offered).toEqual(["read"]);
    } finally {
      for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("modelTools are recomputed the same way, and MCP's tool_search stays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tools-"));
    try {
      const definition = { tools: ["read", "bash"], modelTools: ["read"], mcpServers: ["demo"] };
      const first = await reopen(dir);
      const id = await first.createConversation(MODEL, definition);
      await first.close();
      const second = await reopen(dir, withExtra(), new Map([[id, definition]]));
      expect((await second.toolsOf(id)).offered).toEqual(["read", "tool_search"]);
    } finally {
      for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SessionService applies the filters before every input", async () => {
    const applied: ProfileDefinition[] = [];
    const host = {
      applyProfileTools: (_id: number, definition: ProfileDefinition) => {
        applied.push(definition);
        return Promise.resolve();
      },
      runTurns: () => Promise.resolve(0),
      turnsUsed: () => Promise.resolve(0),
      limitTurns: () => Promise.resolve(),
      submitInput: () => Promise.resolve(),
    } as unknown as Host;
    const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
    const svc = new SessionService(pool, host, {
      shard: 0,
      testFaults: false,
      defaultModel: config.models.default,
      turnBudget: () => 5,
    });
    await svc.apply(
      message("hi", "1"),
      session({ name: "r", version: 1, snapshot: { tools: ["read"] } }, 3),
    );
    expect(applied).toEqual([{ tools: ["read"] }]);
    svc.stop();
  });
});
