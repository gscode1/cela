import { afterEach, describe, expect, it, vi } from "vitest";
import { McpCatalogCache } from "../src/mcp-cache.ts";
import type { McpServerConfig } from "../src/mcp-servers.ts";
import { putMcpServer } from "../src/mcp-servers.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

const BASE = { url: "https://mcp.example.com/mcp", readOnly: true };

const caches: McpCatalogCache[] = [];
function cache(db: FakeSettingsDb, options: ConstructorParameters<typeof McpCatalogCache>[1] = {}) {
  const made = new McpCatalogCache(db.asPool(), { pollMs: 25, relistenMs: 5, ...options });
  caches.push(made);
  return made;
}
afterEach(async () => {
  await Promise.all(caches.splice(0).map((c) => c.stop()));
});

const names = (servers: readonly McpServerConfig[]) => servers.map((s) => s.name);

describe("McpCatalogCache", () => {
  it("loads the table at start; an empty table is an empty catalog", async () => {
    const db = new FakeSettingsDb();
    const empty = cache(db);
    await empty.start();
    expect(empty.loaded).toBe(true);
    expect(empty.get()).toEqual([]);
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    const full = cache(db);
    await full.start();
    expect(names(full.get())).toEqual(["a"]);
  });

  it("refreshes on a pi_mcp_servers notification and tells the subscribers, not on pi_settings", async () => {
    const db = new FakeSettingsDb();
    const c = cache(db, { pollMs: 60_000 });
    const seen: string[][] = [];
    c.subscribe((servers) => seen.push(names(servers)));
    await c.start();
    await vi.waitFor(() => expect(db.listeners.size).toBe(1));
    seen.length = 0;
    // A committed write notifies through the transaction, as in Postgres.
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    await vi.waitFor(() => expect(seen).toEqual([["a"]]));
    const reads = db.statements.length;
    db.notify("pi_settings");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(db.statements.length).toBe(reads);
  });

  it("picks a change up by polling alone, and tells the subscribers once", async () => {
    const db = new FakeSettingsDb();
    const c = cache(db, { pollMs: 20 });
    const seen: string[][] = [];
    c.subscribe((servers) => seen.push(names(servers)));
    await c.start();
    db.listeners.clear(); // nobody is told
    seen.length = 0;
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    await vi.waitFor(() => expect(names(c.get())).toEqual(["a"]));
    await new Promise((resolve) => setTimeout(resolve, 80)); // more polls, no change
    expect(seen).toEqual([["a"]]);
  });

  it("re-listens after the connection drops", async () => {
    const db = new FakeSettingsDb();
    const c = cache(db, { pollMs: 60_000 });
    await c.start();
    await vi.waitFor(() => expect(db.listeners.size).toBe(1));
    const [first] = [...db.listeners];
    first?.drop();
    await vi.waitFor(() => {
      expect(db.listeners.size).toBe(1);
      expect([...db.listeners][0]).not.toBe(first);
    });
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    await vi.waitFor(() => expect(names(c.get())).toEqual(["a"]));
  });

  it("keeps the last good catalog and logs once when the database cannot be read", async () => {
    const db = new FakeSettingsDb();
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    const log = vi.fn();
    const c = cache(db, { log, pollMs: 10 });
    await c.start();
    db.failReads = true;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(names(c.get())).toEqual(["a"]);
    expect(log.mock.calls.filter(([event]) => event === "mcp-catalog-load-failed")).toHaveLength(1);
    db.failReads = false;
    await putMcpServer(db.asPool(), "b", BASE, "alice");
    await vi.waitFor(() => expect(names(c.get())).toEqual(["a", "b"]));
  });

  it("skips a row that turned invalid, logs it once, and keeps the others", async () => {
    const db = new FakeSettingsDb();
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    await putMcpServer(db.asPool(), "b", BASE, "alice");
    const bad = db.mcp.get("b");
    if (bad !== undefined) bad.timeout_ms = 5;
    const log = vi.fn();
    const c = cache(db, { log, pollMs: 10 });
    await c.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(names(c.get())).toEqual(["a"]);
    expect(log.mock.calls.filter(([event]) => event === "mcp-server-invalid")).toHaveLength(1);
  });

  it("a throwing subscriber does not stop the others or the cache", async () => {
    const db = new FakeSettingsDb();
    const c = cache(db);
    const ok = vi.fn();
    c.subscribe(() => {
      throw new Error("boom");
    });
    c.subscribe(ok);
    await c.start();
    ok.mockClear();
    await putMcpServer(db.asPool(), "a", BASE, "alice");
    await c.refresh();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
