import { describe, expect, it } from "vitest";
import {
  listSettingsHistory,
  policyOf,
  readSettings,
  seedSettings,
  settingsFromEnv,
  updateSettings,
  validateSettings,
} from "../src/settings.ts";
import type { Settings } from "../src/settings.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const base: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  tokenBudget: null,
  repoAllowlist: [],
};

describe("settingsFromEnv", () => {
  it("describes the same values the ConfigMap did", () => {
    expect(
      settingsFromEnv({
        PI_MODEL_PROVIDER: "openai-codex",
        PI_MODEL_ID: "gpt-6.1-terra",
        PI_MODEL_ALLOWLIST: "openai-codex/gpt-6.1-sol,scripted/scripted-1",
        PI_MODEL_REASONING: "medium",
        PI_SESSION_TURN_BUDGET: "7",
      }),
    ).toEqual({
      defaultModel: "openai-codex/gpt-6.1-terra",
      allowlist: ["openai-codex/gpt-6.1-terra", "openai-codex/gpt-6.1-sol", "scripted/scripted-1"],
      reasoning: "medium",
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 7,
      tokenBudget: null,
      repoAllowlist: [],
    });
  });

  it("defaults like before and rejects a bad budget", () => {
    expect(settingsFromEnv({}).turnBudget).toBe(100);
    expect(() => settingsFromEnv({ PI_SESSION_TURN_BUDGET: "0" })).toThrow(
      /PI_SESSION_TURN_BUDGET/,
    );
  });

  it("seeds a token budget only when PI_SESSION_TOKEN_BUDGET is set, and rejects a bad one", () => {
    expect(settingsFromEnv({}).tokenBudget).toBeNull();
    expect(settingsFromEnv({ PI_SESSION_TOKEN_BUDGET: "" }).tokenBudget).toBeNull();
    expect(settingsFromEnv({ PI_SESSION_TOKEN_BUDGET: "2000000" }).tokenBudget).toBe(2_000_000);
    expect(() => settingsFromEnv({ PI_SESSION_TOKEN_BUDGET: "lots" })).toThrow(/tokenBudget/);
  });

  it("seeds the repo allowlist from PI_REPO_ALLOWLIST, empty by default, and rejects a bad entry", () => {
    expect(settingsFromEnv({}).repoAllowlist).toEqual([]);
    expect(
      settingsFromEnv({ PI_REPO_ALLOWLIST: " Octo/* , octo/*,acme/app ," }).repoAllowlist,
    ).toEqual(["octo/*", "acme/app"]);
    expect(() => settingsFromEnv({ PI_REPO_ALLOWLIST: "https://github.com/octo/x" })).toThrow(
      /repo allowlist entry/,
    );
  });
});

describe("validateSettings", () => {
  it("accepts a full object and puts the default first in the allowlist, without duplicates", () => {
    expect(
      validateSettings({
        defaultModel: "a/b/c",
        allowlist: ["x/y", "a/b/c", "x/y"],
        reasoning: "high",
        turnBudget: 5,
      }),
    ).toEqual({
      defaultModel: "a/b/c",
      allowlist: ["a/b/c", "x/y"],
      reasoning: "high",
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 5,
      tokenBudget: null,
      repoAllowlist: [],
    });
  });

  it("treats a missing defaultProfile as coding and rejects a bad name", () => {
    const legacy: Record<string, unknown> = { ...base };
    delete legacy.defaultProfile;
    expect(validateSettings(legacy)).toEqual({ ...base, defaultProfile: "coding" });
    expect(validateSettings({ ...base, defaultProfile: "research" })).toMatchObject({
      defaultProfile: "research",
    });
    for (const bad of ["Research", "", 3, null, "a b"]) {
      expect(validateSettings({ ...base, defaultProfile: bad }), String(bad)).toMatch(
        /defaultProfile/,
      );
    }
  });

  it("treats a missing maxReasoning as no cap, so older rows and clients still validate", () => {
    const legacy: Record<string, unknown> = { ...base };
    delete legacy.maxReasoning;
    expect(validateSettings(legacy)).toEqual({ ...base, maxReasoning: null });
  });

  it("treats a missing tokenBudget as no limit, accepts a positive integer and refuses anything else", () => {
    const legacy: Record<string, unknown> = { ...base };
    delete legacy.tokenBudget;
    expect(validateSettings(legacy)).toEqual({ ...base, tokenBudget: null });
    expect(validateSettings({ ...base, tokenBudget: 500_000 })).toMatchObject({
      tokenBudget: 500_000,
    });
    for (const bad of [0, -1, 1.5, "100", 2e12, Number.NaN]) {
      expect(validateSettings({ ...base, tokenBudget: bad }), String(bad)).toMatch(/tokenBudget/);
    }
  });

  it("accepts max as a reasoning level and a cap at or above the default", () => {
    expect(validateSettings({ ...base, reasoning: "max" })).toMatchObject({ reasoning: "max" });
    expect(validateSettings({ ...base, reasoning: "low", maxReasoning: "low" })).toMatchObject({
      reasoning: "low",
      maxReasoning: "low",
    });
    expect(validateSettings({ ...base, maxReasoning: "off" })).toMatchObject({
      maxReasoning: "off",
    });
  });

  it("refuses a default reasoning above the cap, also when a partial update causes it", () => {
    expect(validateSettings({ ...base, reasoning: "high", maxReasoning: "low" })).toMatch(
      /reasoning high is above maxReasoning low/,
    );
    const current = { ...base, reasoning: "high" as const, maxReasoning: "xhigh" as const };
    expect(validateSettings({ maxReasoning: "low" }, current)).toMatch(/above maxReasoning/);
    expect(validateSettings({ maxReasoning: "low", reasoning: "low" }, current)).toMatchObject({
      reasoning: "low",
      maxReasoning: "low",
    });
  });

  it("refuses an unknown cap", () => {
    expect(validateSettings({ ...base, maxReasoning: "ultra" })).toMatch(/maxReasoning must be/);
  });

  it("lays a partial update over the current values; null clears reasoning", () => {
    const current = { ...base, reasoning: "low" as const };
    expect(validateSettings({ turnBudget: 9 }, current)).toEqual({ ...current, turnBudget: 9 });
    expect(validateSettings({ reasoning: null }, current)).toEqual({ ...current, reasoning: null });
  });

  it("requires every field when there is nothing to lay over", () => {
    expect(validateSettings({ turnBudget: 9 })).toMatch(/defaultModel is required/);
  });

  it.each([
    [[], "settings must be a JSON object"],
    [{ nope: 1 }, 'unknown setting "nope"'],
    [{ defaultModel: "noslash" }, "is not provider/model"],
    [{ defaultModel: "a b/c" }, "is not provider/model"],
    [{ defaultModel: 5 }, "defaultModel must be a string"],
    [{ allowlist: "a/b" }, "allowlist must be an array"],
    [{ allowlist: ["a/b", 3] }, "allowlist must be an array"],
    [{ allowlist: ["bad"] }, 'model "bad" is not provider/model'],
    [{ reasoning: "ultra" }, "reasoning must be null or one of"],
    [{ turnBudget: 0 }, "turnBudget must be an integer"],
    [{ turnBudget: 1.5 }, "turnBudget must be an integer"],
    [{ turnBudget: "5" }, "turnBudget must be an integer"],
    [{ turnBudget: 1_000_001 }, "turnBudget must be an integer"],
  ])("rejects %j", (input, message) => {
    expect(validateSettings(input, base)).toContain(message);
  });
});

describe("seed validation", () => {
  it("refuses an env seed the read path would reject, and persists nothing", async () => {
    expect(() => settingsFromEnv({ PI_SESSION_TURN_BUDGET: "1000001" })).toThrow(/turnBudget/);
    const db = new FakeSettingsDb();
    await expect(seedSettings(db.asPool(), { ...base, turnBudget: 1_000_001 })).rejects.toThrow(
      /invalid seed settings/,
    );
    expect(db.row).toBeUndefined();
    expect(db.history).toHaveLength(0);
  });
});

describe("allowlist size", () => {
  const many = Array.from({ length: 100 }, (_, i) => `p/m${String(i)}`);
  const full: Settings = { ...base, defaultModel: "p/m0", allowlist: many };

  it("names the input bound, not the distinct-entry limit, when the list is far too long", () => {
    const huge = Array.from({ length: 1001 }, (_, i) => `p/m${String(i)}`);
    expect(validateSettings({ allowlist: huge }, full)).toMatch(/at most 1000 provider\/model/);
  });

  it("counts the default: a default outside a full list is a 400, not a row the reader rejects", async () => {
    expect(validateSettings({ defaultModel: "x/y" }, full)).toMatch(/at most 100 distinct/);
    expect(validateSettings({ defaultModel: "p/m5" }, full)).toMatchObject({
      defaultModel: "p/m5",
    });
    // Duplicates do not count twice.
    expect(validateSettings({ allowlist: [...many, "p/m1"] }, full)).toMatchObject({
      turnBudget: 100,
    });

    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), full);
    expect(await updateSettings(db.asPool(), { defaultModel: "x/y" }, "alice")).toMatch(
      /at most 100/,
    );
    expect(db.history).toHaveLength(1);
  });
});

describe("policyOf", () => {
  it("gives chooseModel what loadModelPolicy gave it", () => {
    const policy = policyOf({ ...base, reasoning: "low" });
    expect(policy.default).toEqual({ provider: "scripted", model: "scripted-1", reasoning: "low" });
    expect(policy.allowed.map((m) => m.model)).toEqual(["scripted-1", "scripted-2"]);
    expect(policy.reasoning).toBe("low");
    expect(policyOf(base).reasoning).toBeUndefined();
    expect(policyOf(base).maxReasoning).toBeUndefined();
    expect(policyOf({ ...base, maxReasoning: "high" }).maxReasoning).toBe("high");
  });
});

describe("seedSettings", () => {
  it("inserts once; a second seed (another replica, a restart) changes nothing", async () => {
    const db = new FakeSettingsDb();
    expect(await seedSettings(db.asPool(), base)).toBe(true);
    expect(await seedSettings(db.asPool(), { ...base, turnBudget: 1 })).toBe(false);
    expect((await readSettings(db.asPool()))?.settings).toEqual(base);
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({ changed_by: "seed", old: null });
  });

  it("two replicas seeding at once insert exactly one row and one history entry", async () => {
    const db = new FakeSettingsDb();
    const results = await Promise.all([
      seedSettings(db.asPool(), base),
      seedSettings(db.asPool(), base),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.history).toHaveLength(1);
  });
});

describe("updateSettings", () => {
  it("writes the row, a history entry with old and new, and notifies in the same transaction", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    let notified = 0;
    const listener = await db.connect();
    await listener.query("listen pi_settings");
    listener.on("notification", () => notified++);

    const result = await updateSettings(db.asPool(), { turnBudget: 5, reasoning: "low" }, "alice");
    expect(typeof result).toBe("object");
    expect((await readSettings(db.asPool()))?.settings).toEqual({
      ...base,
      turnBudget: 5,
      reasoning: "low",
    });
    expect(db.history).toHaveLength(2);
    expect(db.history[1]).toMatchObject({
      changed_by: "alice",
      old: base,
      new: { ...base, turnBudget: 5, reasoning: "low" },
    });
    expect(notified).toBe(1);
    const history = await listSettingsHistory(db.asPool(), 10);
    expect(history.map((h) => h.changedBy)).toEqual(["alice", "seed"]);
  });

  it("stores a token budget and reads the bigint column back as a number; a partial update keeps it", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    await updateSettings(db.asPool(), { tokenBudget: 750_000 }, "alice");
    expect(db.row?.token_budget).toBe("750000");
    expect((await readSettings(db.asPool()))?.settings.tokenBudget).toBe(750_000);
    await updateSettings(db.asPool(), { turnBudget: 9 }, "alice");
    expect((await readSettings(db.asPool()))?.settings).toMatchObject({
      turnBudget: 9,
      tokenBudget: 750_000,
    });
    await updateSettings(db.asPool(), { tokenBudget: null }, "alice");
    expect((await readSettings(db.asPool()))?.settings.tokenBudget).toBeNull();
  });

  it("stores the repo allowlist lowercased and deduplicated; a partial update keeps it; a row without it reads as empty", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    expect((await readSettings(db.asPool()))?.settings.repoAllowlist).toEqual([]);
    await updateSettings(db.asPool(), { repoAllowlist: ["Octo/*", "octo/*", "acme/app"] }, "alice");
    expect(db.row?.repo_allowlist).toEqual(["octo/*", "acme/app"]);
    await updateSettings(db.asPool(), { turnBudget: 9 }, "alice");
    expect((await readSettings(db.asPool()))?.settings.repoAllowlist).toEqual([
      "octo/*",
      "acme/app",
    ]);
    expect(await updateSettings(db.asPool(), { repoAllowlist: ["octo/he*"] }, "alice")).toMatch(
      /repo allowlist entry "octo\/he\*"/,
    );
    expect(await updateSettings(db.asPool(), { repoAllowlist: "octo/*" }, "alice")).toMatch(
      /repoAllowlist must be an array/,
    );
    expect(
      await updateSettings(
        db.asPool(),
        { repoAllowlist: Array.from({ length: 201 }, (_, i) => `octo/r${String(i)}`) },
        "alice",
      ),
    ).toMatch(/at most 200 distinct/);
  });

  it("stores the cap and refuses one below the stored default", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), { ...base, reasoning: "medium" });
    expect(await updateSettings(db.asPool(), { maxReasoning: "low" }, "alice")).toMatch(
      /above maxReasoning/,
    );
    await updateSettings(db.asPool(), { maxReasoning: "high" }, "alice");
    expect((await readSettings(db.asPool()))?.settings.maxReasoning).toBe("high");
    expect(db.history).toHaveLength(2);
  });

  it("returns the message and writes nothing for an invalid update", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    expect(await updateSettings(db.asPool(), { turnBudget: 0 }, "alice")).toMatch(/turnBudget/);
    expect(db.history).toHaveLength(1);
  });

  it("writes no history for an update that changes nothing", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    await updateSettings(db.asPool(), { turnBudget: 100 }, "alice");
    expect(db.history).toHaveLength(1);
  });

  it("rolls the row back if the history write fails", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    const query = db.query.bind(db);
    db.query = (sql, params) =>
      sql.includes("insert into inbox.settings_history")
        ? Promise.reject(new Error("disk full"))
        : query(sql, params);
    await expect(updateSettings(db.asPool(), { turnBudget: 5 }, "alice")).rejects.toThrow(
      "disk full",
    );
    expect(db.row?.turn_budget).toBe(100);
  });
});

describe("updateSettings against a model catalog", () => {
  const catalog = ["scripted/scripted-1", "scripted/scripted-2", "openai/gpt-x"];

  it("refuses a default or an allowlist entry that is not in the catalog, naming it", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    expect(
      await updateSettings(
        db.asPool(),
        { defaultModel: "openai/nope" },
        "alice",
        undefined,
        catalog,
      ),
    ).toBe('defaultModel "openai/nope" is not in the model catalog');
    expect(
      await updateSettings(
        db.asPool(),
        { allowlist: ["scripted/scripted-1", "openai/typo"] },
        "alice",
        undefined,
        catalog,
      ),
    ).toBe('allowlist entry "openai/typo" is not in the model catalog');
    expect((await readSettings(db.asPool()))?.settings.allowlist).toEqual(base.allowlist);
  });

  it("accepts catalog models, and without a catalog accepts anything as before", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), base);
    const ok = await updateSettings(
      db.asPool(),
      { defaultModel: "openai/gpt-x", allowlist: ["openai/gpt-x"] },
      "alice",
      undefined,
      catalog,
    );
    expect(typeof ok).toBe("object");
    const free = await updateSettings(db.asPool(), { defaultModel: "any/thing" }, "alice");
    expect(typeof free).toBe("object");
  });

  it("does not reject a stored value that is kept, only what a write adds", async () => {
    const db = new FakeSettingsDb();
    await seedSettings(db.asPool(), { ...base, defaultModel: "old/gone", allowlist: ["old/gone"] });
    const stored = await updateSettings(
      db.asPool(),
      { turnBudget: 5 },
      "alice",
      undefined,
      catalog,
    );
    expect(typeof stored).toBe("object");
  });
});
