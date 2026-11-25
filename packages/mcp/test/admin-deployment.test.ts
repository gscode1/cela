import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api.js";
import { withClient } from "./admin-fixture.js";

describe("admin deployment tools", { timeout: 10_000 }, () => {
  let api: FakeApi;
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PI_API_URL: api.url,
    PI_API_TOKEN: api.token,
    PI_MCP_ADMIN: "true",
    PI_API_ADMIN_TOKEN: api.adminToken,
    ...extra,
  });
  beforeEach(async () => {
    api = await FakeApi.start();
  });
  afterEach(async () => {
    await api.close();
  });

  function scriptCatalog(): void {
    api.onAdmin("GET", "/admin/models", { body: { models: [] } });
    api.onAdmin("GET", "/admin/tools", { body: { tools: ["bash"] } });
    api.onAdmin("GET", "/admin/network-modes", { body: { modes: ["proxied"] } });
    api.onAdmin("GET", "/admin/sandbox-flavours", { body: { flavours: ["default"] } });
    api.onAdmin("GET", "/admin/sandbox-sizes", { body: { sizes: [] } });
    api.onAdmin("GET", "/admin/sandbox-runtimes", { body: { runtimes: [] } });
  }

  it("fans the catalog out into one answer, with all models on request", async () => {
    scriptCatalog();
    await withClient(env(), async (client) => {
      const result = await client.callTool({
        name: "admin_get_catalog",
        arguments: { allModels: true },
      });
      expect(result.structuredContent).toEqual({
        models: { models: [] },
        tools: { tools: ["bash"] },
        networkModes: { modes: ["proxied"] },
        sandboxFlavours: { flavours: ["default"] },
        sandboxSizes: { sizes: [] },
        sandboxRuntimes: { runtimes: [] },
      });
    });
    expect(api.adminRequests).toHaveLength(6);
    expect(api.adminRequests[0]?.query).toEqual({ all: "true" });
  });

  it("names the failing part of the catalog", async () => {
    scriptCatalog();
    api.onAdmin("GET", "/admin/sandbox-sizes", { status: 500, body: { error: "boom" } });
    await withClient(env(), async (client) => {
      const result = await client.callTool({ name: "admin_get_catalog", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: "/admin/sandbox-sizes failed: boom",
      });
    });
  });

  it("reads the status", async () => {
    api.onAdmin("GET", "/admin/status", { body: { ok: true } });
    await withClient(env(), async (client) => {
      const result = await client.callTool({ name: "admin_get_status", arguments: {} });
      expect(result.structuredContent).toEqual({ ok: true });
    });
  });

  it("sends the history filters each kind accepts and refuses the others", async () => {
    api.onAdmin("GET", "/admin/settings/history", { body: { history: [] } });
    api.onAdmin("GET", "/admin/mcp-servers/history", { body: { history: [] } });
    api.onAdmin("GET", "/admin/egress/history", { body: { history: [] } });
    await withClient(env(), async (client) => {
      await client.callTool({
        name: "admin_get_history",
        arguments: { kind: "settings", limit: 5 },
      });
      await client.callTool({
        name: "admin_get_history",
        arguments: { kind: "mcp_servers", name: "docs" },
      });
      await client.callTool({
        name: "admin_get_history",
        arguments: { kind: "egress", egressKind: "rule", ref: "42" },
      });
      expect(api.adminRequests.map((r) => [r.path, r.query])).toEqual([
        ["/admin/settings/history", { limit: "5" }],
        ["/admin/mcp-servers/history", { name: "docs" }],
        ["/admin/egress/history", { kind: "rule", ref: "42" }],
      ]);
      const bad = await client.callTool({
        name: "admin_get_history",
        arguments: { kind: "settings", name: "docs" },
      });
      expect(bad.isError).toBe(true);
      const badRef = await client.callTool({
        name: "admin_get_history",
        arguments: { kind: "egress", ref: "../x" },
      });
      expect(badRef.isError).toBe(true);
      expect(api.adminRequests).toHaveLength(3);
    });
  });

  it("lists sessions with an encoded query", async () => {
    api.onAdmin("GET", "/admin/sessions", { body: { sessions: [] } });
    await withClient(env(), async (client) => {
      await client.callTool({
        name: "admin_list_sessions",
        arguments: { owner: "a&b", status: "active", limit: 10, cursor: "c=1" },
      });
    });
    expect(api.adminRequests[0]?.query).toEqual({
      owner: "a&b",
      status: "active",
      limit: "10",
      cursor: "c=1",
    });
  });

  it("registers admin_probe_network only with writes", async () => {
    api.onAdmin("POST", "/admin/status/probe", { status: 202, body: { queued: true } });
    await withClient(env(), async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("admin_probe_network");
      for (const read of [
        "admin_get_catalog",
        "admin_get_status",
        "admin_get_history",
        "admin_list_sessions",
      ])
        expect(names).toContain(read);
    });
    await withClient(env({ PI_MCP_ADMIN_WRITES: "true" }), async (client) => {
      const result = await client.callTool({ name: "admin_probe_network", arguments: {} });
      expect(result.structuredContent).toEqual({ queued: true });
    });
    expect(api.adminRequests.map((r) => r.method)).toEqual(["POST"]);
  });
});
