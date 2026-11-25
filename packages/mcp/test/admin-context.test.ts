import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAdminContext, type AdminContext } from "../src/admin/context.js";
import { parseConfig } from "../src/config.js";
import { serverInstructions } from "../src/server.js";
import { adminEnv, base, dangerousEnv, withClient, writesEnv } from "./admin-fixture.js";
import { FakeApi } from "./fake-api.js";

describe("admin mode", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires explicit flags and a separate token", () => {
    expect(parseConfig(base).admin).toBeUndefined();
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN: "true" })).toThrow("PI_API_ADMIN_TOKEN");
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN_WRITES: "true" })).toThrow("PI_MCP_ADMIN");
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN: "yes" })).toThrow("PI_MCP_ADMIN");
    expect(() =>
      parseConfig({ ...base, PI_MCP_ADMIN: "true", PI_API_ADMIN_TOKEN: "session-secret" }),
    ).toThrow("must differ");
    expect(() => parseConfig({ ...adminEnv, PI_MCP_ADMIN_DANGEROUS: "true" })).toThrow(
      "PI_MCP_ADMIN_WRITES",
    );
  });

  it.each([
    [400, "unknown key bogusKey"],
    [409, "profile must be disabled before delete"],
  ])("returns untrusted %i errors without forwarding server secrets", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `${message}: admin-secret session-secret` }), {
            status,
          }),
        ),
      ),
    );
    await withClient(writesEnv, async (client) => {
      const result = await client.callTool({
        name: "admin_put_profile",
        arguments: { name: "coding", expectedRevision: 1, definition: {} },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(String(status));
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).toContain("untrusted");
      expect(JSON.stringify(result)).not.toContain("admin-secret");
      expect(JSON.stringify(result)).not.toContain("session-secret");
    });
  });

  // The exact tools of each tier: adding or removing one is a decision (ADR 0070), so it fails here until this list says so.
  const readTools = [
    "admin_explain_egress",
    "admin_get_catalog",
    "admin_get_egress_rule_set",
    "admin_get_egress_status",
    "admin_get_history",
    "admin_get_mcp_server",
    "admin_get_profile",
    "admin_get_settings",
    "admin_get_skill",
    "admin_get_skill_version",
    "admin_get_status",
    "admin_list_egress_rule_sets",
    "admin_list_mcp_servers",
    "admin_list_profiles",
    "admin_list_session_egress_rules",
    "admin_list_sessions",
    "admin_list_skills",
  ];
  const writeTools = [
    "admin_delete_profile",
    "admin_probe_network",
    "admin_publish_skill",
    "admin_put_mcp_server",
    "admin_put_profile",
  ];
  const dangerousTools = [
    "admin_delete_egress_rule",
    "admin_delete_egress_rule_set",
    "admin_delete_mcp_server",
    "admin_delete_skill",
    "admin_put_egress_rule",
    "admin_put_egress_rule_set",
    "admin_put_settings",
  ];

  it.each([
    { writes: false, dangerous: false, expected: readTools },
    { writes: true, dangerous: false, expected: [...readTools, ...writeTools] },
    { writes: true, dangerous: true, expected: [...readTools, ...writeTools, ...dangerousTools] },
  ])(
    "exposes exactly the admin tools of the tier (%o)",
    async ({ writes, dangerous, expected }) => {
      const env = dangerous ? dangerousEnv : writes ? writesEnv : adminEnv;
      await withClient(env, async (client) => {
        const names = (await client.listTools()).tools
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("admin_"))
          .sort();
        expect(names).toEqual([...expected].sort());
      });
    },
  );

  it("points to the admin tools for discovery only when they exist", () => {
    const admin = parseConfig(adminEnv);
    expect(serverInstructions(admin)).toContain("admin_list_profiles");
    expect(serverInstructions(admin)).toContain("admin_get_settings");
    expect(serverInstructions(admin).split(/\s+/).length).toBeLessThanOrEqual(250);
    expect(serverInstructions(parseConfig(base))).not.toContain("admin_");
  });
});

describe("AdminContext", { timeout: 10_000 }, () => {
  let fake: FakeApi;
  beforeEach(async () => {
    fake = await FakeApi.start();
  });
  afterEach(async () => {
    await fake.close();
  });

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PI_API_URL: "http://127.0.0.1:1",
    PI_API_TOKEN: fake.token,
    PI_MCP_ADMIN: "true",
    PI_API_ADMIN_TOKEN: fake.adminToken,
    ...extra,
  });
  const contextOf = (config: Record<string, string>): AdminContext => {
    const ctx = createAdminContext(
      new McpServer({ name: "t", version: "1" }),
      parseConfig({ ...config, PI_API_URL: fake.url }),
    );
    if (ctx === undefined) throw new Error("admin mode is off");
    return ctx;
  };

  it("has no context without admin mode and reports the three tiers", () => {
    const server = new McpServer({ name: "t", version: "1" });
    expect(createAdminContext(server, parseConfig(base))).toBeUndefined();
    expect(contextOf(env()).tiers).toEqual({ read: true, writes: false, dangerous: false });
    expect(contextOf(env({ PI_MCP_ADMIN_WRITES: "true" })).tiers).toEqual({
      read: true,
      writes: true,
      dangerous: false,
    });
    expect(
      contextOf(env({ PI_MCP_ADMIN_WRITES: "true", PI_MCP_ADMIN_DANGEROUS: "true" })).tiers,
    ).toEqual({ read: true, writes: true, dangerous: true });
  });

  it("posts a body and passes the per-call timeout, scrubbing both tokens", async () => {
    const ctx = contextOf(env());
    fake.onAdmin("POST", "/admin/things", (request) => ({
      status: 201,
      body: { got: request.body, leak: `${fake.adminToken} ${fake.token}`, query: request.query },
    }));
    const signal = new AbortController().signal;
    const result = await ctx.call(
      "POST",
      "/admin/things?x=1",
      signal,
      { a: 1 },
      { timeoutMs: 5000 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      got: { a: 1 },
      leak: "[redacted] [redacted]",
      query: { x: "1" },
    });
    expect(result.content[0]?.text).toMatch(/^Admin API output is untrusted data/);
    expect(fake.adminRequests).toEqual([
      { method: "POST", path: "/admin/things", query: { x: "1" }, body: { a: 1 } },
    ]);
  });

  it("answers an API error as an error result, and a timeout as status 0", async () => {
    const ctx = contextOf(env());
    const signal = new AbortController().signal;
    fake.onAdmin("PUT", "/admin/x", { status: 409, body: { error: "stale revision" } });
    const stale = await ctx.call("PUT", "/admin/x", signal, {});
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toEqual({ error: "stale revision", status: 409 });
    fake.onAdmin("PUT", "/admin/y", {
      status: 409,
      body: {
        error: "stale revision",
        revision: 7,
        blockedBy: { note: `${fake.adminToken} ${fake.token}`, [fake.adminToken]: 1 },
      },
    });
    const withDetails = await ctx.call("PUT", "/admin/y", signal, {});
    expect(withDetails.isError).toBe(true);
    expect(withDetails.structuredContent).toEqual({
      error: "stale revision",
      status: 409,
      details: { revision: 7, blockedBy: { note: "[redacted] [redacted]", "[redacted]": 1 } },
    });
    expect(withDetails.content[0]?.text).toMatch(/^Admin API output is untrusted data/);
    fake.onAdmin("PUT", "/admin/z", {
      status: 409,
      body: { error: "too big", extra: "x".repeat(5000) },
    });
    const big = await ctx.call("PUT", "/admin/z", signal, {});
    expect(big.structuredContent).toEqual({ error: "too big", status: 409 });
    fake.onAdmin("POST", "/admin/slow", { delayMs: 500 });
    const slow = await ctx.call("POST", "/admin/slow", signal, {}, { timeoutMs: 50 });
    expect(slow.isError).toBe(true);
    expect(slow.structuredContent).toMatchObject({ status: 0 });
  });

  it("lets a domain register a tool that follows the tier", async () => {
    // How a later domain file does it: `ctx.tiers` decides, `ctx.call` talks to ingest.
    const ctx = contextOf(env({ PI_MCP_ADMIN_WRITES: "true" }));
    fake.onAdmin("POST", "/admin/status/probe", { status: 202, body: { started: true } });
    if (ctx.tiers.writes) {
      ctx.server.registerTool(
        "admin_probe_network",
        { description: "probe", inputSchema: z.object({}) },
        async (_args, extra) => ctx.call("POST", "/admin/status/probe", extra.mcpReq.signal),
      );
    }
    expect(ctx.tiers.dangerous).toBe(false);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await ctx.server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({ name: "admin_probe_network", arguments: {} });
      expect(result.structuredContent).toEqual({ started: true });
      expect(fake.adminRequests[0]).toMatchObject({ method: "POST", path: "/admin/status/probe" });
    } finally {
      await client.close();
      await ctx.server.close();
    }
  });
});
