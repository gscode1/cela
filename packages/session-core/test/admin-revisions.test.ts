import { describe, expect, it } from "vitest";
import {
  AdminConflictError,
  DEFAULT_PROFILE_LOCK,
  deleteMcpServer,
  parseExpectedRevision,
  putMcpServer,
  putProfile,
  readMcpServers,
  readProfile,
  readSettings,
  seedSettings,
  updateSettings,
} from "../src/index.ts";
import type { Settings } from "../src/index.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const KNOWN = { tools: ["read", "write", "edit", "bash"], mcpServers: ["demo"] };
const SEED: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  tokenBudget: null,
};
const SERVER = { url: "https://mcp.example.com/mcp", readOnly: true };

async function seeded(): Promise<FakeSettingsDb> {
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), SEED);
  return db;
}

describe("parseExpectedRevision", () => {
  it("takes a positive integer or nothing", () => {
    expect(parseExpectedRevision(undefined)).toBeUndefined();
    expect(parseExpectedRevision(3)).toBe(3);
    for (const bad of [0, -1, 1.5, "1", null, true, 2 ** 31]) {
      expect(parseExpectedRevision(bad), String(bad)).toBe(
        "expectedRevision must be a positive integer",
      );
    }
  });
});

describe("settings revision", () => {
  it("starts at 1, counts real writes only and refuses a stale expectedRevision", async () => {
    const db = await seeded();
    const pool = db.asPool();
    expect((await readSettings(pool))?.revision).toBe(1);
    const first = await updateSettings(pool, { turnBudget: 5 }, "alice", 1);
    expect(typeof first === "string" ? first : first.revision).toBe(2);
    // No change: no write, no new revision.
    const same = await updateSettings(pool, { turnBudget: 5 }, "alice");
    expect(typeof same === "string" ? same : same.revision).toBe(2);
    const history = db.history.length;
    await expect(updateSettings(pool, { turnBudget: 6 }, "bob", 1)).rejects.toThrow(
      AdminConflictError,
    );
    expect((await readSettings(pool))?.settings.turnBudget).toBe(5);
    expect(db.history).toHaveLength(history);
    // Omitted: today's behaviour.
    const last = await updateSettings(pool, { turnBudget: 7 }, "bob");
    expect(typeof last === "string" ? last : last.revision).toBe(3);
  });
});

describe("profile revision", () => {
  it("changes on a new version and on enable and disable, and a stale one changes nothing", async () => {
    const db = await seeded();
    const pool = db.asPool();
    const created = await putProfile(pool, "research", { definition: {} }, "alice", KNOWN);
    expect(created.ok && created.stored.revision).toBe(1);
    const version = await putProfile(
      pool,
      "research",
      { definition: { turnBudget: 3 }, expectedRevision: 1 },
      "alice",
      KNOWN,
    );
    expect(version.ok && version.stored.revision).toBe(2);
    const off = await putProfile(
      pool,
      "research",
      { enabledForNew: false, expectedRevision: 2 },
      "alice",
      KNOWN,
    );
    expect(off.ok && [off.stored.revision, off.stored.currentVersion]).toEqual([3, 2]);
    const on = await putProfile(pool, "research", { enabledForNew: true }, "alice", KNOWN);
    expect(on.ok && on.stored.revision).toBe(4);
    // Identical content writes nothing.
    const noop = await putProfile(pool, "research", { enabledForNew: true }, "alice", KNOWN);
    expect(noop.ok && noop.stored.revision).toBe(4);

    for (const body of [
      { definition: { turnBudget: 9 }, expectedRevision: 3 },
      { enabledForNew: false, expectedRevision: 3 },
      { enabledForNew: true, expectedRevision: 3 },
    ]) {
      await expect(putProfile(pool, "research", body, "bob", KNOWN)).rejects.toThrow(
        AdminConflictError,
      );
    }
    const stored = await readProfile(pool, "research");
    expect(stored).toMatchObject({ revision: 4, currentVersion: 2, enabledForNew: true });
    expect(db.versions.filter((v) => v.name === "research")).toHaveLength(2);
    // A profile that does not exist cannot match any revision.
    await expect(
      putProfile(pool, "ghost", { definition: {}, expectedRevision: 1 }, "bob", KNOWN),
    ).rejects.toThrow(/does not exist/);
    expect(db.profiles.has("ghost")).toBe(false);
  });
});

describe("MCP server revision", () => {
  it("counts writes, refuses a stale put or delete and changes nothing", async () => {
    const db = await seeded();
    const pool = db.asPool();
    const created = await putMcpServer(pool, "demo", SERVER, "alice");
    expect(typeof created === "string" ? created : created.stored.revision).toBe(1);
    const off = await putMcpServer(pool, "demo", { enabled: false }, "alice", 1);
    expect(typeof off === "string" ? off : off.stored.revision).toBe(2);
    const same = await putMcpServer(pool, "demo", { enabled: false }, "alice");
    expect(typeof same === "string" ? same : same.stored.revision).toBe(2);
    const history = db.mcpHistory.length;
    await expect(putMcpServer(pool, "demo", { enabled: true }, "bob", 1)).rejects.toThrow(
      AdminConflictError,
    );
    await expect(deleteMcpServer(pool, "demo", "bob", 1)).rejects.toThrow(AdminConflictError);
    await expect(putMcpServer(pool, "new", { ...SERVER }, "bob", 1)).rejects.toThrow(
      /does not exist/,
    );
    const catalog = await readMcpServers(pool);
    expect(catalog.servers.map((s) => [s.server.name, s.server.enabled, s.revision])).toEqual([
      ["demo", false, 2],
    ]);
    expect(db.mcpHistory).toHaveLength(history);
    expect(await deleteMcpServer(pool, "demo", "bob", 2)).toBe(true);
    // A missing server is still "not found", not a conflict.
    expect(await deleteMcpServer(pool, "demo", "bob", 2)).toBe(false);
  });

  it("stores `source` beside the server, keeps it on a partial update and clears it with null", async () => {
    const db = await seeded();
    const pool = db.asPool();
    const source = { repository: "github.com/acme/catalog", commit: "0123abc" };
    const created = await putMcpServer(pool, "demo", { ...SERVER, source }, "alice");
    expect(typeof created === "string" ? created : created.stored.source).toEqual(source);
    const kept = await putMcpServer(pool, "demo", { timeoutMs: 5000 }, "alice");
    expect(typeof kept === "string" ? kept : kept.stored.source).toEqual(source);
    // The same server with a new commit is a write (a revision), with the same server config.
    const moved = await putMcpServer(
      pool,
      "demo",
      { source: { ...source, commit: "fedcba9" } },
      "alice",
    );
    expect(
      typeof moved === "string" ? moved : [moved.stored.revision, moved.stored.source],
    ).toEqual([3, { ...source, commit: "fedcba9" }]);
    const cleared = await putMcpServer(pool, "demo", { source: null }, "alice");
    expect(typeof cleared === "string" ? cleared : cleared.stored.source).toBeNull();
    for (const bad of [
      "x",
      [],
      {},
      { repository: "r", commit: "zz" },
      { repository: "a b", commit: "0123abc" },
      { repository: "r", commit: "0123abc", extra: 1 },
    ]) {
      expect(
        await putMcpServer(pool, "demo", { source: bad }, "alice"),
        JSON.stringify(bad),
      ).toMatch(/source/);
    }
  });
});

describe("the default profile guard", () => {
  const put = (db: FakeSettingsDb, name: string, body: Record<string, unknown>) =>
    putProfile(db.asPool(), name, body, "alice", KNOWN);

  it("refuses to disable the default profile and says to select another first", async () => {
    const db = await seeded();
    await expect(put(db, "coding", { enabledForNew: false })).rejects.toThrow(
      /default profile.*select another/,
    );
    expect(db.profiles.get("coding")?.enabled_for_new).toBe(true);
    // A settings row without a default means `coding`.
    db.setRow({ default_profile: null });
    await expect(put(db, "coding", { enabledForNew: false })).rejects.toThrow(AdminConflictError);
    // Another profile may be disabled, and so may the old default once it is not the default.
    await put(db, "research", { definition: {} });
    expect((await put(db, "research", { enabledForNew: false })).ok).toBe(true);
    await put(db, "research", { enabledForNew: true });
    await updateSettings(db.asPool(), { defaultProfile: "research" }, "alice");
    expect((await put(db, "coding", { enabledForNew: false })).ok).toBe(true);
  });

  it("refuses a default that is disabled, missing or invalid", async () => {
    const db = await seeded();
    await put(db, "research", { definition: {} });
    await put(db, "research", { enabledForNew: false });
    expect(await updateSettings(db.asPool(), { defaultProfile: "research" }, "alice")).toMatch(
      /disabled for new sessions/,
    );
    expect(await updateSettings(db.asPool(), { defaultProfile: "ghost" }, "alice")).toMatch(
      /does not exist/,
    );
    expect((await readSettings(db.asPool()))?.settings.defaultProfile).toBe("coding");
  });

  it("checks inside the write transaction: a profile disabled while the lock is held is seen", async () => {
    const db = await seeded();
    await put(db, "research", { definition: {} });
    // Another writer holds the lock mid-transaction; the settings write waits for it, then reads its result.
    const other = await db.connect();
    await other.query("begin");
    await other.query("select pg_advisory_xact_lock(hashtext($1))", [DEFAULT_PROFILE_LOCK]);
    const pending = updateSettings(db.asPool(), { defaultProfile: "research" }, "alice");
    const raced = Symbol("pending");
    expect(await Promise.race([pending, new Promise((r) => setTimeout(() => r(raced), 20))])).toBe(
      raced,
    );
    const row = db.profiles.get("research");
    if (row !== undefined) row.enabled_for_new = false;
    await other.query("commit");
    other.release();
    expect(await pending).toMatch(/disabled for new sessions/);
  });

  it.each([["settings first"], ["disable first"]])(
    "a concurrent select and disable never leave a disabled default (%s)",
    async (order) => {
      const db = await seeded();
      await put(db, "research", { definition: {} });
      const holder = await db.connect();
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext($1))", [DEFAULT_PROFILE_LOCK]);
      const select = () => updateSettings(db.asPool(), { defaultProfile: "research" }, "alice");
      const disable = () =>
        put(db, "research", { enabledForNew: false }).then(
          (result) => result,
          (error: unknown) => error,
        );
      const started = order === "settings first" ? [select(), disable()] : [disable(), select()];
      await new Promise((resolve) => setTimeout(resolve, 10));
      await holder.query("commit");
      holder.release();
      await Promise.all(started);
      const settings = (await readSettings(db.asPool()))?.settings;
      const profile = await readProfile(db.asPool(), settings?.defaultProfile ?? "");
      expect(profile?.enabledForNew).toBe(true);
    },
  );
});
