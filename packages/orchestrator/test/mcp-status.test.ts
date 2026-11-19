import type pg from "pg";
import { createRegistry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpTools } from "../src/mcp.ts";
import type { McpServerSpec, McpStatusReport, McpTimings } from "../src/mcp.ts";
import {
  MAX_DISCOVERY_ERROR_LENGTH,
  mcpStatusRecorder,
  sanitizeDiscoveryError,
} from "../src/mcp-status.ts";
import { FakeMcp } from "./fake-mcp.ts";

const SPEC: McpServerSpec = {
  name: "demo",
  url: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 300,
  maxOutputBytes: 24_576,
  onecliSecret: null,
};
const TIMINGS: McpTimings = { discoveryTimeoutMs: 200, retryMinMs: 10, retryMaxMs: 40 };
const ECHO = { name: "echo", inputSchema: { type: "object" } };

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("discovery status reports of McpTools", () => {
  const started: McpTools[] = [];
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const tools of started.splice(0)) await tools.close();
    vi.restoreAllMocks();
  });

  function open(fake: FakeMcp) {
    const reports: McpStatusReport[] = [];
    const tools = new McpTools(createRegistry(), fake.transport, TIMINGS, undefined, (report) =>
      reports.push(report),
    );
    started.push(tools);
    tools.start();
    return { tools, reports };
  }

  it("reports each failed attempt, then ready with the tool names", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO, { name: "ping", inputSchema: { type: "object" } }];
    fake.down = true;
    const { tools, reports } = open(fake);
    tools.apply([SPEC]);
    await until(() => reports.filter((r) => r.state === "failed").length >= 2, "two failures");
    fake.down = false;
    await until(() => reports.some((r) => r.state === "ready"), "ready");
    expect(reports.at(-1)).toEqual({ server: "demo", state: "ready", toolNames: ["echo", "ping"] });
    expect(reports[0]).toMatchObject({ server: "demo", state: "failed" });
  }, 5000);

  it("reports removed when a server leaves the catalog or is replaced, and nothing for a retired server's attempts", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const { tools, reports } = open(fake);
    tools.apply([SPEC]);
    await until(() => reports.length === 1, "ready");
    tools.apply([{ ...SPEC, url: "https://other.example.com/mcp" }]);
    expect(reports[1]).toEqual({ server: "demo", state: "removed" });
    await until(() => reports.length === 3, "ready again");
    tools.apply([{ ...SPEC, enabled: false }]);
    expect(reports.at(-1)).toEqual({ server: "demo", state: "removed" });
    const count = reports.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reports).toHaveLength(count);
  }, 5000);
});

describe("sanitizeDiscoveryError", () => {
  it("keeps an ordinary error as it is", () => {
    expect(sanitizeDiscoveryError("mcp demo connect timed out after 15000 ms")).toBe(
      "mcp demo connect timed out after 15000 ms",
    );
  });

  it("removes credentials a transport or gateway may echo", () => {
    const secrets = [
      "Authorization: Bearer abc123def456ghi789",
      "x-api-key: sk-live-0123456789abcdef",
      "X-OneCLI-Token=oc_supersecretvalue1234",
      "Cookie: session=deadbeefdeadbeef",
    ];
    for (const secret of secrets) {
      const out = sanitizeDiscoveryError(`HTTP 401 from gateway; request had ${secret}`);
      expect(out).toContain("HTTP 401");
      expect(out).not.toMatch(/abc123|0123456789abcdef|supersecret|deadbeef/);
    }
    expect(sanitizeDiscoveryError("fetch https://user:hunter2@mcp.example.com/mcp failed")).toBe(
      "fetch https://[redacted]@mcp.example.com/mcp failed",
    );
    expect(sanitizeDiscoveryError("GET https://h/mcp?api_key=topsecret&x=1 -> 500")).toBe(
      "GET https://h/mcp?api_key=[redacted]&x=1 -> 500",
    );
    expect(sanitizeDiscoveryError("bad token eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl")).not.toContain(
      "eyJ",
    );
    expect(sanitizeDiscoveryError(`opaque ${"a1B2".repeat(12)} value`)).toBe(
      "opaque [redacted] value",
    );
  });

  it("collapses whitespace and truncates to the limit", () => {
    const out = sanitizeDiscoveryError(`line one\n\n  line two ${"word ".repeat(200)}`);
    expect(out.startsWith("line one line two word")).toBe(true);
    expect(out).toHaveLength(MAX_DISCOVERY_ERROR_LENGTH);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("mcpStatusRecorder", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes into the shard's own row in order, with a sanitized error and no credential", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = vi.fn((sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows: [] });
    });
    const record = mcpStatusRecorder({ query } as unknown as pg.Pool, 3);
    record({ server: "demo", state: "failed", message: "boom Bearer abcdefghijklmnop" });
    record({ server: "demo", state: "ready", toolNames: ["a", "b"] });
    record({ server: "demo", state: "removed" });
    await vi.waitFor(() => expect(calls).toHaveLength(3), { timeout: 1000 });
    expect(calls.map((c) => c.params[0])).toEqual([3, 3, 3]);
    expect(JSON.parse(String(calls[0]?.params[2]))).toEqual({
      state: "failed",
      error: "boom Bearer [redacted]",
    });
    expect(JSON.parse(String(calls[1]?.params[2]))).toEqual({
      state: "ready",
      tools: 2,
      toolNames: ["a", "b"],
    });
    expect(calls[2]?.sql).toContain("mcp_discovery - $2");
  }, 3000);

  it("logs and survives a failed write", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({ rows: [] });
    const record = mcpStatusRecorder({ query } as unknown as pg.Pool, 0);
    record({ server: "a", state: "removed" });
    record({ server: "b", state: "removed" });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2), { timeout: 1000 });
  }, 3000);
});
