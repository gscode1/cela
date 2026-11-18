import { describe, expect, it } from "vitest";
import {
  createEgressRule,
  createRuleSet,
  deleteEgressRule,
  deleteRuleSet,
  listEgressHistory,
  readEgress,
  updateEgressRule,
  updateRuleSet,
} from "../src/egress-store.ts";
import { AdminBlockedError } from "../src/deletion.ts";
import { MAX_EGRESS_RULES, MAX_RULE_SETS, evaluateEgress } from "../src/egress-rules.ts";
import { AdminConflictError } from "../src/revision.ts";
import { FakeEgressDb } from "./fake-egress-db.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const SESSION = "11111111-2222-4333-8444-555555555555";

async function setUp(db: FakeEgressDb, name = "web", expected?: number) {
  const set = await createRuleSet(db.asPool(), name, { description: "d" }, "alice", expected);
  if (typeof set === "string") throw new Error(set);
  return set;
}
const addRule = (
  db: FakeEgressDb,
  ruleSet: string,
  host: string,
  extra: object = {},
  expected?: number,
) =>
  createEgressRule(
    db.asPool(),
    { ruleSet },
    { effect: "allow", host, ...extra },
    "alice",
    expected,
    NOW,
  );

describe("egress store: rule sets", () => {
  it("starts at revision 0 and bumps it on every write, with history and a notification each", async () => {
    const db = new FakeEgressDb();
    expect(await readEgress(db.asPool())).toEqual({
      revision: 0,
      ruleSets: [],
      rules: [],
      invalid: [],
    });

    const created = await setUp(db, "web", 0);
    expect(created).toMatchObject({
      name: "web",
      description: "d",
      appliesToAll: false,
      revision: 1,
      createdBy: "alice",
    });
    const updated = await updateRuleSet(db.asPool(), "web", { appliesToAll: true }, "bob", 1);
    expect(updated).toMatchObject({
      appliesToAll: true,
      description: "d",
      revision: 2,
      updatedBy: "bob",
      createdBy: "alice",
    });
    expect(await deleteRuleSet(db.asPool(), "web", "carol", 2)).toBe(true);

    expect(db.notifications).toEqual(["1", "2", "3"]);
    const history = await listEgressHistory(db.asPool(), 10);
    expect(history.map((h) => [h.kind, h.ref, h.action, h.revision, h.changedBy])).toEqual([
      ["rule-set", "web", "delete", 3, "carol"],
      ["rule-set", "web", "update", 2, "bob"],
      ["rule-set", "web", "create", 1, "alice"],
    ]);
    expect(history[2]).toMatchObject({ old: null, new: { description: "d", appliesToAll: false } });
  });

  it("refuses a duplicate name, a bad name and the limit; a stale revision is a conflict", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    await expect(setUp(db)).rejects.toBeInstanceOf(AdminConflictError);
    expect(await createRuleSet(db.asPool(), "Bad Name", {}, "alice")).toContain("name");
    expect(await createRuleSet(db.asPool(), "x1", { rules: [] }, "alice")).toContain(
      "unknown field",
    );
    await expect(setUp(db, "other", 0)).rejects.toBeInstanceOf(AdminConflictError);
    await expect(
      updateRuleSet(db.asPool(), "web", { description: "z" }, "bob", 9),
    ).rejects.toBeInstanceOf(AdminConflictError);
    await expect(deleteRuleSet(db.asPool(), "web", "bob", 9)).rejects.toBeInstanceOf(
      AdminConflictError,
    );
    expect(db.revision).toBe(1);
    expect(db.notifications).toEqual(["1"]);

    const full = new FakeEgressDb();
    for (let i = 0; i < MAX_RULE_SETS; i++) full.insertRawSet(`s${String(i)}`);
    await expect(setUp(full, "one-more")).rejects.toBeInstanceOf(AdminConflictError);
  });

  it("writes nothing for a no-op update, answers undefined or false for a missing set", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    expect(await updateRuleSet(db.asPool(), "web", { description: "d" }, "bob")).toMatchObject({
      revision: 1,
      updatedBy: "alice",
    });
    expect(await updateRuleSet(db.asPool(), "web", { appliesToAll: "x" }, "bob")).toContain(
      "boolean",
    );
    expect(await updateRuleSet(db.asPool(), "nope", {}, "bob")).toBeUndefined();
    expect(await deleteRuleSet(db.asPool(), "nope", "bob")).toBe(false);
    expect(db.revision).toBe(1);
  });

  it("deletes the rules with the set and keeps them in the history", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    await addRule(db, "web", "a.example.com");
    await addRule(db, "web", ".b.example.com");
    expect(await deleteRuleSet(db.asPool(), "web", "carol")).toBe(true);
    expect(db.rules).toHaveLength(0);
    const [latest] = await listEgressHistory(db.asPool(), 1);
    expect(latest).toMatchObject({ kind: "rule-set", action: "delete", revision: 4 });
    expect((latest?.old as { rules: { host: string }[] }).rules.map((r) => r.host)).toEqual([
      "a.example.com",
      ".b.example.com",
    ]);
  });

  it("refuses to delete a set a profile names, listing the profiles, and changes nothing", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    db.profiles.set("scraper", ["web"]);
    db.profiles.set("coding", []);
    const error = await deleteRuleSet(db.asPool(), "web", "bob").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminBlockedError);
    expect((error as AdminBlockedError).blockedBy).toEqual({
      profiles: [{ name: "scraper", version: 1 }],
    });
    expect(db.ruleSets).toHaveLength(1);
    expect(db.revision).toBe(1);
    db.profiles.delete("scraper");
    expect(await deleteRuleSet(db.asPool(), "web", "bob")).toBe(true);
  });
});

describe("egress store: rules", () => {
  it("creates, updates and deletes a rule in a set, each a revision with history", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    const a = await addRule(db, "web", "a.example.com", { note: "n" }, 1);
    if (a === undefined || typeof a === "string") throw new Error("create failed");
    expect(a).toMatchObject({
      id: "1",
      ruleSet: "web",
      sessionId: null,
      revision: 2,
      host: "a.example.com",
      private: false,
    });
    const updated = await updateEgressRule(
      db.asPool(),
      a.id,
      { note: "why", route: "onecli" },
      "bob",
      2,
      NOW,
    );
    expect(updated).toMatchObject({
      note: "why",
      route: "onecli",
      revision: 3,
      updatedBy: "bob",
      createdBy: "alice",
      ruleSet: "web",
    });
    expect(await deleteEgressRule(db.asPool(), a.id, "carol", 3)).toBe(true);
    expect(db.notifications).toEqual(["1", "2", "3", "4"]);
    const history = await listEgressHistory(db.asPool(), 10, { kind: "rule" });
    expect(history.map((h) => [h.ref, h.action, h.revision])).toEqual([
      ["1", "delete", 4],
      ["1", "update", 3],
      ["1", "create", 2],
    ]);
    expect(history[2]).toMatchObject({
      old: null,
      new: { ruleSet: "web", host: "a.example.com", note: "n", private: false },
    });
    expect(await listEgressHistory(db.asPool(), 10, { ref: "web" })).toHaveLength(1);
  });

  it("creates a rule for a session and answers undefined for a missing rule set", async () => {
    const db = new FakeEgressDb();
    const own = await createEgressRule(
      db.asPool(),
      { sessionId: SESSION },
      { effect: "allow", host: "github.com", route: "onecli" },
      "orch",
      undefined,
      NOW,
    );
    expect(own).toMatchObject({ ruleSet: null, sessionId: SESSION, route: "onecli" });
    expect(await addRule(db, "missing", "a.example.com")).toBeUndefined();
    expect(db.rules).toHaveLength(1);
    expect(db.revision).toBe(1);
  });

  it("stores a private rule and reads it back", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    const rule = await addRule(db, "web", "10.20.0.0/16", { private: true, ports: [8080] });
    expect(rule).toMatchObject({ private: true, host: "10.20.0.0/16", ports: [8080] });
    expect((await readEgress(db.asPool())).rules[0]).toMatchObject({ private: true });
    expect(await addRule(db, "web", "10.20.0.0/16", { private: true })).toContain("explicit ports");
    expect(await addRule(db, "web", "127.0.0.0/8", { private: true, ports: [80] })).toContain(
      "always-blocked",
    );
  });

  it("refuses a stale expectedRevision and writes nothing, not even a revision", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    await addRule(db, "web", "a.example.com");
    await expect(addRule(db, "web", "b.example.com", {}, 1)).rejects.toBeInstanceOf(
      AdminConflictError,
    );
    await expect(
      updateEgressRule(db.asPool(), "1", { note: "x" }, "bob", 7),
    ).rejects.toBeInstanceOf(AdminConflictError);
    await expect(deleteEgressRule(db.asPool(), "1", "bob", 0)).rejects.toBeInstanceOf(
      AdminConflictError,
    );
    expect(await addRule(db, "web", "10.0.0.1")).toContain("IP");
    expect(await updateEgressRule(db.asPool(), "1", { ports: [] }, "bob")).toContain("ports");
    expect(db.rules).toHaveLength(1);
    expect(db.revision).toBe(2);
    expect(db.notifications).toEqual(["1", "2"]);
  });

  it("writes nothing for a no-op update; undefined or false for a missing rule", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    await addRule(db, "web", "a.example.com");
    expect(
      await updateEgressRule(db.asPool(), "1", { host: "A.example.com.", ports: [443] }, "bob", 2),
    ).toMatchObject({ revision: 2, updatedBy: "alice" });
    expect(db.revision).toBe(2);
    expect(await updateEgressRule(db.asPool(), "5", { note: "x" }, "bob")).toBeUndefined();
    expect(await deleteEgressRule(db.asPool(), "5", "bob")).toBe(false);
    expect(db.revision).toBe(2);
  });

  it("refuses a rule after the maximum", async () => {
    const db = new FakeEgressDb();
    db.insertRawSet("web");
    for (let i = 0; i < MAX_EGRESS_RULES; i++)
      db.insertRaw({ host: `h${String(i)}.example.com`, rule_set: "web", session_id: null });
    await expect(addRule(db, "web", "one-more.example.com")).rejects.toBeInstanceOf(
      AdminConflictError,
    );
    expect(db.rules).toHaveLength(MAX_EGRESS_RULES);
  });

  it("rolls back when the write fails midway", async () => {
    const db = new FakeEgressDb();
    await setUp(db);
    const original = db.query.bind(db);
    db.query = (sql, params) =>
      /insert into egress\.rules\s*\(/.test(sql)
        ? Promise.reject(new Error("connection lost"))
        : original(sql, params);
    await expect(addRule(db, "web", "a.example.com")).rejects.toThrow("connection lost");
    expect(db.rules).toHaveLength(0);
    expect(db.revision).toBe(1);
    expect(db.notifications).toEqual(["1"]);
    expect(db.history).toHaveLength(1);
  });

  it("reports a hand-edited invalid row, still reads the others, and a replacement must be complete", async () => {
    const db = new FakeEgressDb();
    db.insertRawSet("web");
    db.insertRaw({ host: "a.example.com", rule_set: "web", session_id: null });
    db.insertRaw({ host: "10.0.0.1", rule_set: "web", session_id: null });
    const read = await readEgress(db.asPool());
    expect(read.rules.map((r) => r.id)).toEqual(["1"]);
    expect(read.invalid).toEqual([
      { kind: "rule", ref: "2", message: expect.stringContaining("invalid") as unknown },
    ]);
    expect(await updateEgressRule(db.asPool(), "2", { note: "x" }, "bob")).toContain("effect");
    expect(
      await updateEgressRule(db.asPool(), "2", { effect: "deny", host: "b.example.com" }, "bob"),
    ).toMatchObject({ host: "b.example.com" });
  });

  it("keeps an expired rule readable and evaluates it as ignored", async () => {
    const db = new FakeEgressDb();
    db.insertRawSet("web", { applies_to_all: true });
    db.insertRaw({
      host: "a.example.com",
      rule_set: "web",
      session_id: null,
      expires_at: "2026-01-01T00:00:00.000Z",
    });
    const read = await readEgress(db.asPool());
    expect(read.rules).toHaveLength(1);
    expect(
      evaluateEgress(read.ruleSets, read.rules, { host: "a.example.com", port: 443, now: NOW })
        .decision,
    ).toBe("deny");
  });
});
