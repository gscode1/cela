import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  clearMcpDiscovery,
  discoveryView,
  MAX_DISCOVERY_TOOL_NAMES,
  readMcpDiscovery,
  recordMcpDiscovery,
} from "../src/mcp-discovery.ts";
import type { McpDiscoveryOutcome } from "../src/mcp-discovery.ts";

const T1 = "2026-11-19T10:00:00.000Z";
const ready: McpDiscoveryOutcome = {
  state: "ready",
  tools: 2,
  toolNames: ["a", "b"],
  checkedAt: T1,
};
const failed: McpDiscoveryOutcome = { state: "failed", error: "timed out", checkedAt: T1 };

describe("discovery store", () => {
  it("writes only the named shard's row and server, capping the tool names but not the count", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as pg.Pool;
    const names = Array.from({ length: MAX_DISCOVERY_TOOL_NAMES + 50 }, (_, i) => `t${String(i)}`);
    await recordMcpDiscovery(pool, 2, "demo", {
      state: "ready",
      tools: names.length,
      toolNames: names,
    });
    expect(query.mock.calls[0]?.[0]).toContain("where shard = $1");
    const [shard, server, body] = query.mock.calls[0]?.[1] as [number, string, string];
    expect([shard, server]).toEqual([2, "demo"]);
    const parsed = JSON.parse(body) as { tools: number; toolNames: string[] };
    expect(parsed.tools).toBe(MAX_DISCOVERY_TOOL_NAMES + 50);
    expect(parsed.toolNames).toHaveLength(MAX_DISCOVERY_TOOL_NAMES);
    await clearMcpDiscovery(pool, 2, "demo");
    expect(query.mock.calls[1]?.[0]).toContain("mcp_discovery - $2");
  }, 1000);

  it("reads the outcomes by server then shard, tolerating rows without any", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { shard: 0, mcpDiscovery: { demo: ready } },
        { shard: 1, mcpDiscovery: null },
        { shard: 2, mcpDiscovery: { demo: failed, other: ready } },
      ],
    });
    const read = await readMcpDiscovery({ query } as unknown as pg.Pool);
    expect(read.get("demo")?.get(2)).toEqual(failed);
    expect([...(read.get("other")?.keys() ?? [])]).toEqual([2]);
  }, 1000);
});

describe("discoveryView", () => {
  it("is unknown without a report and disabled for a disabled server whatever was reported", () => {
    expect(discoveryView(true, undefined)).toEqual({
      reachability: "unknown",
      discovery: { state: "unknown", tools: 0, checkedAt: null },
    });
    expect(discoveryView(false, new Map([[0, ready]]))).toEqual({
      reachability: "unknown",
      discovery: { state: "disabled", tools: 0, checkedAt: null },
    });
  });

  it("is ok with tools, or failing with the error", () => {
    expect(discoveryView(true, new Map([[0, ready]]))).toEqual({
      reachability: "ok",
      discovery: { state: "ready", tools: 2, toolNames: ["a", "b"], checkedAt: T1, shard: 0 },
    });
    expect(discoveryView(true, new Map([[0, failed]]))).toEqual({
      reachability: "failing",
      discovery: { state: "failed", tools: 0, error: "timed out", checkedAt: T1, shard: 0 },
    });
  });

  it("lets a failure on any shard win, the lowest failing shard first", () => {
    const other: McpDiscoveryOutcome = { ...failed, error: "refused" };
    const view = discoveryView(
      true,
      new Map<number, McpDiscoveryOutcome>([
        [0, ready],
        [3, other],
        [1, failed],
      ]),
    );
    expect(view.reachability).toBe("failing");
    expect(view.discovery).toMatchObject({ shard: 1, error: "timed out" });
  });
});
