import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  checkProfileNames,
  createSession,
  getSession,
  listProfileVersions,
  publishCapabilities,
  putProfile,
  readCapabilities,
  readProfile,
  readProfiles,
  validateProfileDefinition,
} from "../src/index.ts";
import type { ProfileDefinition } from "../src/index.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const KNOWN = { tools: ["read", "write", "edit", "bash"], mcpServers: ["demo", "other"] };

describe("validateProfileDefinition", () => {
  it("accepts the empty definition (today's behaviour) and a full one, normalised in a fixed key order", () => {
    expect(validateProfileDefinition({})).toEqual({});
    const full = validateProfileDefinition({
      mcpServers: ["demo", "demo", "other"],
      turnBudget: 12,
      reasoning: "low",
      defaultModel: "openrouter/openai/gpt-4.1-nano",
      instructions: "Only read.",
      modelTools: ["read"],
      tools: ["read", "bash", "read"],
    });
    expect(full).toEqual({
      tools: ["read", "bash"],
      modelTools: ["read"],
      instructions: "Only read.",
      defaultModel: "openrouter/openai/gpt-4.1-nano",
      reasoning: "low",
      turnBudget: 12,
      mcpServers: ["demo", "other"],
    });
    expect(Object.keys(full as object)).toEqual([
      "tools",
      "modelTools",
      "instructions",
      "defaultModel",
      "reasoning",
      "turnBudget",
      "mcpServers",
    ]);
  });

  it.each([
    [[], "definition must be a JSON object"],
    ["x", "definition must be a JSON object"],
    [null, "definition must be a JSON object"],
    [{ extra: 1 }, 'unknown field "extra"'],
    [{ tools: "read" }, "tools must be an array"],
    [{ tools: ["Read"] }, "tools must contain only tool names"],
    [{ tools: Array.from({ length: 33 }, (_, i) => `t${String(i)}`) }, "at most 32"],
    [{ tools: ["read"], modelTools: ["bash"] }, 'modelTools "bash" is not in tools'],
    [{ instructions: "" }, "instructions"],
    [{ instructions: "   " }, "instructions"],
    [{ instructions: "a\u0000b" }, "instructions"],
    [{ instructions: "x".repeat(8001) }, "instructions"],
    [{ instructions: 3 }, "instructions"],
    [{ defaultModel: "nomodel" }, "not provider/model"],
    [{ defaultModel: 3 }, "defaultModel"],
    [{ reasoning: "extreme" }, "reasoning must be one of"],
    [{ reasoning: null }, "reasoning must be one of"],
    [{ turnBudget: 0 }, "turnBudget"],
    [{ turnBudget: 1.5 }, "turnBudget"],
    [{ turnBudget: 1_000_001 }, "turnBudget"],
    [{ turnBudget: "5" }, "turnBudget"],
    [{ mcpServers: ["Bad Name"] }, "mcpServers must contain only MCP server names"],
    [{ mcpServers: "demo" }, "mcpServers must be an array"],
  ])("rejects %j", (input, message) => {
    const result = validateProfileDefinition(input);
    expect(typeof result).toBe("string");
    expect(result).toContain(message);
  });

  it("is idempotent and survives JSON, so what is written is what is read back (property over generated input)", () => {
    // A small deterministic generator (no extra dependency): mixes valid and invalid values.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const pick = <T>(values: T[]): T => values[next() % values.length] as T;
    const names = ["read", "write", "bash", "edit", "read", "grep", "Bad", ""];
    const servers = ["demo", "other", "demo", "history", "x-y", "UP"];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 2000; i += 1) {
      const input: Record<string, unknown> = {};
      if (next() % 2 === 0) input.tools = Array.from({ length: next() % 5 }, () => pick(names));
      if (next() % 3 === 0)
        input.modelTools = Array.from({ length: next() % 3 }, () => pick(names));
      if (next() % 2 === 0) input.instructions = pick(["be brief", "ok", "fine", "", "a\u0000"]);
      if (next() % 2 === 0) input.defaultModel = pick(["a/b", "a/b/c", "p/m", "x", 3]);
      if (next() % 2 === 0) input.reasoning = pick(["low", "max", "high", "nope"]);
      if (next() % 2 === 0) input.turnBudget = pick([1, 50, 7, 1_000_000, 0, "7"]);
      if (next() % 2 === 0)
        input.mcpServers = Array.from({ length: next() % 3 }, () => pick(servers));
      const first = validateProfileDefinition(input);
      if (typeof first === "string") {
        rejected += 1;
        continue;
      }
      accepted += 1;
      const stored = JSON.parse(JSON.stringify(first)) as unknown;
      expect(validateProfileDefinition(stored)).toEqual(first);
      expect(JSON.stringify(validateProfileDefinition(stored))).toBe(JSON.stringify(first));
    }
    // Not vacuous: both outcomes happened a lot.
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
});

describe("checkProfileNames", () => {
  it("checks tools and modelTools against the installed tools and MCP servers against the catalog", () => {
    expect(checkProfileNames({ tools: ["read"], mcpServers: ["demo"] }, KNOWN)).toBeUndefined();
    expect(checkProfileNames({ tools: ["grep"] }, KNOWN)).toMatch(
      /"grep" is not an installed tool/,
    );
    expect(checkProfileNames({ modelTools: ["grep"] }, KNOWN)).toMatch(/modelTools: "grep"/);
    expect(checkProfileNames({ mcpServers: ["nope"] }, KNOWN)).toMatch(/not in the MCP catalog/);
  });

  it("the built-in names are the four coding tools", () => {
    expect([...BUILTIN_TOOL_NAMES]).toEqual(["read", "write", "edit", "bash"]);
  });
});

describe("putProfile versioning", () => {
  const research: ProfileDefinition = { tools: ["read"], mcpServers: ["demo"], turnBudget: 5 };

  it("creates version 1, versions a change, and writes nothing for an identical definition", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const created = await putProfile(pool, "research", { definition: research }, "alice", KNOWN);
    expect(created).toMatchObject({ ok: true, created: true, versionCreated: true });
    expect(await readProfile(pool, "research")).toMatchObject({
      currentVersion: 1,
      enabledForNew: true,
      createdBy: "alice",
      definition: research,
    });

    // Same content, other key order: a no-op.
    const same = await putProfile(
      pool,
      "research",
      { definition: { turnBudget: 5, mcpServers: ["demo"], tools: ["read"] } },
      "bob",
      KNOWN,
    );
    expect(same).toMatchObject({ ok: true, created: false, versionCreated: false });
    expect(db.versions.filter((v) => v.name === "research")).toHaveLength(1);
    expect((await readProfile(pool, "research"))?.updatedBy).toBe("alice");

    const changed = await putProfile(
      pool,
      "research",
      { definition: { ...research, turnBudget: 6 } },
      "bob",
      KNOWN,
    );
    expect(changed).toMatchObject({ ok: true, created: false, versionCreated: true });
    expect(await readProfile(pool, "research")).toMatchObject({
      currentVersion: 2,
      updatedBy: "bob",
      createdBy: "alice",
      definition: { turnBudget: 6 },
    });
    const versions = await listProfileVersions(pool, "research");
    expect(versions.map((v) => [v.version, v.createdBy, v.definition.turnBudget])).toEqual([
      [2, "bob", 6],
      [1, "alice", 5],
    ]);
  });

  it("toggles enabledForNew without a new version, and keeps the profile resolvable", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    await putProfile(pool, "research", { definition: research }, "alice", KNOWN);
    const off = await putProfile(pool, "research", { enabledForNew: false }, "alice", KNOWN);
    expect(off).toMatchObject({ ok: true, versionCreated: false });
    expect(await readProfile(pool, "research")).toMatchObject({
      enabledForNew: false,
      currentVersion: 1,
    });
    expect(db.versions.filter((v) => v.name === "research")).toHaveLength(1);
  });

  it("rejects what the read path would reject, and names that do not exist, and writes nothing", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const bad: [unknown, RegExp][] = [
      [{ definition: { tools: ["read"], modelTools: ["bash"] } }, /not in tools/],
      [{ definition: { turnBudget: 0 } }, /turnBudget/],
      [{ definition: { tools: ["grep"] } }, /not an installed tool/],
      [{ definition: { mcpServers: ["nope"] } }, /not in the MCP catalog/],
      [{}, /definition, enabledForNew or both/],
      [{ enabledForNew: "yes", definition: {} }, /enabledForNew must be a boolean/],
      [{ enabledForNew: true }, /definition is required/],
    ];
    for (const [input, message] of bad) {
      const result = await putProfile(pool, "fresh", input as never, "alice", KNOWN);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toMatch(message);
    }
    expect((await putProfile(pool, "Bad Name", { definition: {} }, "a", KNOWN)).ok).toBe(false);
    expect(db.profiles.has("fresh")).toBe(false);
    expect(db.versions).toHaveLength(1);
    // An update that fails validation leaves the current version.
    await putProfile(pool, "research", { definition: research }, "alice", KNOWN);
    const failed = await putProfile(
      pool,
      "research",
      { definition: { tools: ["grep"] } },
      "a",
      KNOWN,
    );
    expect(failed.ok).toBe(false);
    expect((await readProfile(pool, "research"))?.currentVersion).toBe(1);
  });

  it("an identical re-PUT does not re-check the names (a tool that vanished later must not block a no-op)", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    await putProfile(pool, "research", { definition: research }, "alice", KNOWN);
    const again = await putProfile(pool, "research", { definition: research }, "alice", {
      tools: [],
      mcpServers: [],
    });
    expect(again).toMatchObject({ ok: true, versionCreated: false });
  });

  it("readProfiles skips and reports a row edited by hand into something invalid", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    await putProfile(pool, "research", { definition: research }, "alice", KNOWN);
    const version = db.versions.find((v) => v.name === "research");
    if (version !== undefined) version.definition = { tools: "read" };
    const catalog = await readProfiles(pool);
    expect(catalog.profiles.map((p) => p.name)).toEqual(["coding"]);
    expect(catalog.invalid).toEqual([
      {
        name: "research",
        message:
          "stored profile research is invalid: tools must be an array of at most 32 tool names",
      },
    ]);
    await expect(readProfile(pool, "research")).rejects.toThrow(/invalid/);
  });
});

describe("snapshot round trip", () => {
  it("a session stores name, version and the resolved definition; later edits never change it", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const definition: ProfileDefinition = { tools: ["read"], instructions: "v1 rules" };
    await putProfile(pool, "research", { definition }, "alice", KNOWN);
    const stored = await readProfile(pool, "research");
    const id = await createSession(
      pool,
      { owner: "alice", subject: "static:alice" },
      { provider: "scripted", model: "scripted-1" },
      undefined,
      {
        name: "research",
        version: stored?.currentVersion ?? 0,
        definition: stored?.definition ?? {},
      },
    );
    await putProfile(
      pool,
      "research",
      { definition: { instructions: "v2 rules" } },
      "alice",
      KNOWN,
    );
    await putProfile(pool, "research", { enabledForNew: false }, "alice", KNOWN);
    expect((await getSession(pool, id))?.profile).toEqual({
      name: "research",
      version: 1,
      snapshot: definition,
    });
  });

  it("a session created without a profile has none (it runs as coding v1)", async () => {
    const db = new FakeSettingsDb();
    const id = await createSession(
      db.asPool(),
      { owner: "alice", subject: "static:alice" },
      { provider: "scripted", model: "scripted-1" },
    );
    expect((await getSession(db.asPool(), id))?.profile).toBeNull();
  });
});

describe("capabilities", () => {
  it("publishes once and again (one row), and reads back; none before an orchestrator started", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    expect(await readCapabilities(pool)).toBeUndefined();
    await publishCapabilities(pool, { tools: ["read"], extensions: ["coding-tools"] }, "o1");
    await publishCapabilities(
      pool,
      { tools: ["read", "bash"], extensions: ["coding-tools"] },
      "o2",
    );
    expect(await readCapabilities(pool)).toEqual({
      tools: ["read", "bash"],
      extensions: ["coding-tools"],
    });
    expect(db.capabilities?.instance).toBe("o2");
  });
});
