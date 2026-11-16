import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsCache } from "../src/settings-cache.ts";
import type { Settings } from "../src/settings.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const fallback: Settings = {
  defaultModel: "env/model",
  allowlist: ["env/model"],
  reasoning: null,
  turnBudget: 11,
};

const caches: SettingsCache[] = [];
function cache(db: FakeSettingsDb, options: ConstructorParameters<typeof SettingsCache>[1] = {}) {
  const made = new SettingsCache(db.asPool(), { pollMs: 25, relistenMs: 5, ...options });
  caches.push(made);
  return made;
}
afterEach(async () => {
  await Promise.all(caches.splice(0).map((c) => c.stop()));
});

describe("SettingsCache", () => {
  it("loads the row at start and answers the accessors from it", async () => {
    const db = new FakeSettingsDb();
    db.setRow({ default_reasoning: "low", turn_budget: 7 });
    const c = cache(db);
    await c.start();
    expect(c.loaded).toBe(true);
    expect(c.turnBudget()).toBe(7);
    expect(c.defaultReasoning()).toBe("low");
    expect(c.policy().default.model).toBe("scripted-1");
  });

  it("uses the fallback while the row is missing, then the row once it exists", async () => {
    const db = new FakeSettingsDb();
    const log = vi.fn();
    const c = cache(db, { fallback, log });
    await c.start();
    expect(c.loaded).toBe(false);
    expect(c.turnBudget()).toBe(11);
    expect(log).toHaveBeenCalledWith("settings-row-missing", {});
    db.setRow({ turn_budget: 3 });
    await c.refresh();
    expect(c.turnBudget()).toBe(3);
  });

  it("throws only when nothing was ever read and there is no fallback", async () => {
    const c = cache(new FakeSettingsDb());
    await c.start();
    expect(() => c.get()).toThrow(/not loaded/);
  });

  it("refreshes on a pi_settings notification, without waiting for the poll", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    const c = cache(db, { pollMs: 60_000 });
    await c.start();
    await vi.waitFor(() => expect(db.listeners.size).toBe(1));
    db.setRow({ turn_budget: 42 });
    db.notify();
    await vi.waitFor(() => expect(c.turnBudget()).toBe(42));
  });

  it("re-listens after the connection drops, and the poll covers the gap", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    const c = cache(db);
    await c.start();
    await vi.waitFor(() => expect(db.listeners.size).toBe(1));
    const [first] = [...db.listeners];
    db.setRow({ turn_budget: 8 });
    first?.drop();
    await vi.waitFor(() => expect(c.turnBudget()).toBe(8));
    await vi.waitFor(() => {
      expect(db.listeners.size).toBe(1);
      expect([...db.listeners][0]).not.toBe(first);
    });
  });

  it("picks a change up by polling alone when no notification arrives", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    const c = cache(db, { pollMs: 20 });
    await c.start();
    db.listeners.clear(); // nobody is told
    db.setRow({ turn_budget: 9 });
    await vi.waitFor(() => expect(c.turnBudget()).toBe(9));
  });

  it("keeps the last good value and logs once when the row turns bad", async () => {
    const db = new FakeSettingsDb();
    db.setRow({ turn_budget: 5 });
    const log = vi.fn();
    const c = cache(db, { log, pollMs: 10 });
    await c.start();
    db.setRow({ turn_budget: 0 }); // violates the budget rule
    await c.refresh();
    await new Promise((resolve) => setTimeout(resolve, 60)); // several polls
    expect(c.turnBudget()).toBe(5);
    const failures = log.mock.calls.filter(([event]) => event === "settings-load-failed");
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).toContain("stored settings are invalid");
    db.setRow({ turn_budget: 6 });
    await c.refresh();
    expect(c.turnBudget()).toBe(6);
  });

  it("keeps the last good value when the database cannot be read", async () => {
    const db = new FakeSettingsDb();
    db.setRow({ turn_budget: 5 });
    const c = cache(db);
    await c.start();
    db.failReads = true;
    await c.refresh();
    expect(c.turnBudget()).toBe(5);
  });

  it("does not throw from start when the first read fails", async () => {
    const db = new FakeSettingsDb();
    db.failReads = true;
    const c = cache(db, { fallback });
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.turnBudget()).toBe(11);
  });

  it("releases the listener client once: stop() during the relisten delay does not throw", async () => {
    const db = new FakeSettingsDb();
    db.setRow();
    const c = cache(db, { relistenMs: 60_000, pollMs: 60_000 });
    await c.start();
    await vi.waitFor(() => expect(db.listeners.size).toBe(1));
    const [client] = [...db.listeners];
    client?.drop();
    await vi.waitFor(() => expect(client?.released).toBe(true));
    await expect(c.stop()).resolves.toBeUndefined();
    await expect(c.stop()).resolves.toBeUndefined();
  });
});
