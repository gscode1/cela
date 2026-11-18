import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  checkProfileNames,
  createSession,
  getSession,
  listProfileVersions,
  publishCapabilities,
  publishModelProviders,
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
      tokenBudget: 250_000,
      reasoning: "low",
      defaultModel: "openrouter/openai/gpt-4.1-nano",
      instructions: "Only read.",
      modelTools: ["read"],
      tools: ["read", "bash", "read"],
      sandboxSizes: ["l", "m", "l"],
      sandboxSize: "s",
    });
    expect(full).toEqual({
      tools: ["read", "bash"],
      modelTools: ["read"],
      instructions: "Only read.",
      defaultModel: "openrouter/openai/gpt-4.1-nano",
      reasoning: "low",
      turnBudget: 12,
      tokenBudget: 250_000,
      mcpServers: ["demo", "other"],
      sandboxSize: "s",
      sandboxSizes: ["l", "m"],
    });
    expect(Object.keys(full as object)).toEqual([
      "tools",
      "modelTools",
      "instructions",
      "defaultModel",
      "reasoning",
      "turnBudget",
      "tokenBudget",
      "mcpServers",
      "sandboxSize",
      "sandboxSizes",
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
    [{ tokenBudget: 0 }, "tokenBudget"],
    [{ tokenBudget: 1.5 }, "tokenBudget"],
    [{ tokenBudget: 1_000_000_000_001 }, "tokenBudget"],
    [{ tokenBudget: null }, "tokenBudget"],
    [{ tokenBudget: "5" }, "tokenBudget"],
    [{ mcpServers: ["Bad Name"] }, "mcpServers must contain only MCP server names"],
    [{ mcpServers: "demo" }, "mcpServers must be an array"],
    [{ sandboxSize: "Big" }, "sandboxSize must be a size name"],
    [{ sandboxSize: 3 }, "sandboxSize must be a size name"],
    [{ sandboxSizes: "m" }, "sandboxSizes must be an array"],
    [{ sandboxSizes: ["x".repeat(17)] }, "sandboxSizes must contain only size names"],
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

describe("egressRuleSets", () => {
  it("is validated as a list of rule set names, deduplicated, in a fixed key order", () => {
    expect(
      validateProfileDefinition({ egressRuleSets: ["npm", "pypi", "npm"], sandboxSize: "s" }),
    ).toEqual({
      sandboxSize: "s",
      egressRuleSets: ["npm", "pypi"],
    });
    for (const bad of [
      "npm",
      [1],
      ["Npm"],
      ["a b"],
      ["x".repeat(33)],
      Array.from({ length: 65 }, (_, i) => `s${String(i)}`),
    ]) {
      expect(typeof validateProfileDefinition({ egressRuleSets: bad }), JSON.stringify(bad)).toBe(
        "string",
      );
    }
  });

  it("must name rule sets that exist when the profile is written", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    db.egressRuleSets.add("npm");
    const missing = await putProfile(
      db.asPool(),
      "web",
      { definition: { egressRuleSets: ["npm", "nope"] } },
      "alice",
      KNOWN,
    );
    expect(missing).toMatchObject({
      ok: false,
      message: expect.stringContaining('"nope"') as unknown,
    });
    expect(await readProfile(db.asPool(), "web")).toBeUndefined();
    const ok = await putProfile(
      db.asPool(),
      "web",
      { definition: { egressRuleSets: ["npm"] } },
      "alice",
      KNOWN,
    );
    expect(ok).toMatchObject({ ok: true, created: true });
    expect((await readProfile(db.asPool(), "web"))?.definition.egressRuleSets).toEqual(["npm"]);
    db.egressRuleSets.delete("npm");
    const gone = await putProfile(
      db.asPool(),
      "web",
      { definition: { egressRuleSets: ["npm"], instructions: "x" } },
      "alice",
      KNOWN,
    );
    expect(gone).toMatchObject({ ok: false });
  });

  it("cannot name the derived MCP rule set: it applies to nobody and is not for a profile (ADR 0040)", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    db.egressRuleSets.add("mcp-catalog");
    const refused = await putProfile(
      db.asPool(),
      "web",
      { definition: { egressRuleSets: ["mcp-catalog"] } },
      "alice",
      KNOWN,
    );
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringContaining('"mcp-catalog"') as unknown,
    });
    expect(await readProfile(db.asPool(), "web")).toBeUndefined();
  });
});

describe("repoSkills", () => {
  it("is a boolean, absent means off, and it keeps its place in the key order", () => {
    expect(validateProfileDefinition({ repoSkills: true, instructions: "x" })).toEqual({
      instructions: "x",
      repoSkills: true,
    });
    expect(validateProfileDefinition({})).toEqual({});
    expect(validateProfileDefinition({ repoSkills: "yes" })).toMatch(
      /repoSkills must be true or false/,
    );
  });

  it("is refused when tools or modelTools leave out read, like skills", () => {
    expect(validateProfileDefinition({ tools: ["bash"], repoSkills: true })).toMatch(
      /repoSkills needs the read tool, but tools does not include it/,
    );
    expect(
      validateProfileDefinition({
        tools: ["read", "bash"],
        modelTools: ["bash"],
        repoSkills: true,
      }),
    ).toMatch(/modelTools does not include it/);
    expect(validateProfileDefinition({ tools: ["bash"], repoSkills: false })).toEqual({
      tools: ["bash"],
      repoSkills: false,
    });
    expect(validateProfileDefinition({ tools: ["read"], repoSkills: true })).toEqual({
      tools: ["read"],
      repoSkills: true,
    });
  });
});

describe("repoContext", () => {
  it("is a boolean, absent means off, and it needs no read tool (the file goes into the prompt as text)", () => {
    expect(validateProfileDefinition({ repoContext: true, repoSkills: true })).toEqual({
      repoSkills: true,
      repoContext: true,
    });
    expect(validateProfileDefinition({ tools: ["bash"], repoContext: true })).toEqual({
      tools: ["bash"],
      repoContext: true,
    });
    expect(validateProfileDefinition({ repoContext: 1 })).toMatch(
      /repoContext must be true or false/,
    );
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

  it("checks sandboxSize and sandboxSizes against the deployment's sizes, and refuses any without sizes", () => {
    const sized = { ...KNOWN, sandboxSizes: ["s", "m"] };
    expect(checkProfileNames({ sandboxSize: "m", sandboxSizes: ["s"] }, sized)).toBeUndefined();
    expect(checkProfileNames({ sandboxSize: "xl" }, sized)).toBe(
      'sandbox size "xl" is not defined (defined: s, m)',
    );
    expect(checkProfileNames({ sandboxSizes: ["s", "l"] }, sized)).toMatch(/"l" is not defined/);
    expect(checkProfileNames({ sandboxSize: "s" }, KNOWN)).toMatch(/defines no sandbox sizes/);
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
    // `/profiles/new` is the admin console's create route.
    expect(await putProfile(pool, "new", { definition: {} }, "a", KNOWN)).toEqual({
      ok: false,
      message: 'profile name "new" is reserved',
    });
    expect(db.profiles.has("new")).toBe(false);
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

  it("checks defaultModel against the catalog only when it changes (ADR 0025)", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const old = { ...research, defaultModel: "old/m1" };
    await putProfile(pool, "research", { definition: old }, "alice", {
      ...KNOWN,
      models: ["old/m1"],
    });
    // old/m1 has left the catalog: another field can still change, keeping it.
    const gone = { ...KNOWN, models: ["new/m2"] };
    const kept = await putProfile(
      pool,
      "research",
      { definition: { ...old, instructions: "be nice" } },
      "alice",
      gone,
    );
    expect(kept).toMatchObject({ ok: true, versionCreated: true });
    expect(await readProfile(pool, "research")).toMatchObject({
      definition: { defaultModel: "old/m1", instructions: "be nice" },
    });
    // A changed model is checked.
    const changed = await putProfile(
      pool,
      "research",
      { definition: { ...old, defaultModel: "other/m3" } },
      "alice",
      gone,
    );
    expect(changed).toEqual({
      ok: false,
      message: 'defaultModel "other/m3" is not in the model catalog',
    });
    const accepted = await putProfile(
      pool,
      "research",
      { definition: { ...old, defaultModel: "new/m2" } },
      "alice",
      gone,
    );
    expect(accepted).toMatchObject({ ok: true, versionCreated: true });
    // Setting the old model back is a change, so it is checked.
    const back = await putProfile(pool, "research", { definition: old }, "alice", gone);
    expect(back.ok).toBe(false);
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

  it("round-trips the model catalog and the credential hints, and reads an old row without them", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const models = [{ provider: "scripted", id: "scripted-1", reasoning: false }];
    const modelProviders = [{ provider: "scripted", credential: "configured" as const }];
    await publishCapabilities(pool, { tools: [], extensions: [], models, modelProviders }, "o1");
    expect(await readCapabilities(pool)).toMatchObject({ models, modelProviders });
    await publishCapabilities(pool, { tools: [], extensions: [] }, "o2");
    const old = await readCapabilities(pool);
    expect(old?.models).toBeUndefined();
    expect(old?.modelProviders).toBeUndefined();
  });

  it("replaces only the credential hints, reports a change, and writes nothing before a start publish", async () => {
    const db = new FakeSettingsDb();
    const pool = db.asPool();
    const missing = [{ provider: "openai-codex", credential: "missing" as const }];
    const configured = [{ provider: "openai-codex", credential: "configured" as const }];
    expect(await publishModelProviders(pool, configured)).toBe(false);
    expect(db.capabilities).toBeUndefined();
    const models = [{ provider: "openai-codex", id: "gpt-x", reasoning: true }];
    await publishCapabilities(
      pool,
      { tools: ["read"], extensions: [], models, modelProviders: missing },
      "o1",
    );
    expect(await publishModelProviders(pool, configured)).toBe(true);
    expect(await publishModelProviders(pool, configured)).toBe(false);
    expect(await readCapabilities(pool)).toEqual({
      tools: ["read"],
      extensions: [],
      models,
      modelProviders: configured,
    });
    expect(db.capabilities?.instance).toBe("o1");
  });

  it("checks a profile's defaultModel against the catalog only when one is given", () => {
    const known = { tools: [], mcpServers: [] };
    const definition = { defaultModel: "openai/gpt-x" };
    expect(checkProfileNames(definition, known)).toBeUndefined();
    expect(checkProfileNames(definition, { ...known, models: ["scripted/scripted-1"] })).toMatch(
      /defaultModel "openai\/gpt-x" is not in the model catalog/,
    );
    expect(checkProfileNames(definition, { ...known, models: ["openai/gpt-x"] })).toBeUndefined();
  });
});

describe("strings Postgres cannot store", () => {
  it.each(["a\u0000b", "lone \ud800 high", "lone \udc00 low"])(
    "rejects %j in instructions and defaultModel, so the write is a 400 and never a 500",
    (text) => {
      expect(validateProfileDefinition({ instructions: text })).toMatch(/instructions/);
      expect(validateProfileDefinition({ defaultModel: `p/${text}` })).toMatch(/defaultModel/);
    },
  );

  it("accepts a well-formed surrogate pair", () => {
    expect(validateProfileDefinition({ instructions: "ok \u{1f600}" })).toEqual({
      instructions: "ok \u{1f600}",
    });
  });
});
