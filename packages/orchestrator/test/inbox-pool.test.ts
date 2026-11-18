import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INBOX_POOL_LISTENERS, INBOX_POOL_SIZE, MAX_PARALLEL_SESSIONS } from "../src/inbox.ts";

/** The orchestrator's inbox pool is sized from its users (issue #208, docs/decisions/0005). */
const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

describe("the inbox pool", () => {
  it("counts every client that holds a LISTEN connection on it for good", () => {
    // InboxLoop (inbox_events), SettingsCache and McpCatalogCache each keep one pool client in LISTEN.
    const listeners = [
      ...main.matchAll(/new (InboxLoop|SettingsCache|McpCatalogCache)\(\s*pool\b/g),
    ];
    expect(listeners.map((m) => m[1]).sort()).toEqual([
      "InboxLoop",
      "McpCatalogCache",
      "SettingsCache",
    ]);
    expect(INBOX_POOL_LISTENERS).toBe(listeners.length);
  });

  it("leaves every parallel drain its claim client plus one for the queries nested in it, and headroom", () => {
    expect(INBOX_POOL_SIZE).toBeGreaterThan(INBOX_POOL_LISTENERS + 2 * MAX_PARALLEL_SESSIONS);
  });

  it("is what main.ts creates", () => {
    expect(main).toMatch(/createPool\([^)]*`\$\{config\.instance\}-inbox`,\s*INBOX_POOL_SIZE,/);
  });
});
