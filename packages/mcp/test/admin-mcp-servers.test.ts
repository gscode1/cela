import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MCP_OUTPUT_BYTES, type McpServerConfig } from "@cela/session-core";
import { MCP_SERVER_SHAPE } from "../src/admin/mcp-servers.js";
import { FakeApi } from "./fake-api.js";
import { adminEnv, dangerousEnv, withClient, writesEnv } from "./admin-fixture.js";

describe("admin MCP server tools", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the name of admin_get_mcp_server before making a request", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      const valid = await client.callTool({
        name: "admin_get_mcp_server",
        arguments: { name: "a".repeat(32) },
      });
      expect(valid.isError).not.toBe(true);
      const invalid = await client.callTool({
        name: "admin_get_mcp_server",
        arguments: { name: "a".repeat(33) },
      });
      expect(invalid.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("lists and gets from /admin/mcp-servers", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      await client.callTool({ name: "admin_list_mcp_servers", arguments: {} });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/mcp-servers",
        expect.objectContaining({ method: "GET" }),
      );
      const result = await client.callTool({
        name: "admin_get_mcp_server",
        arguments: { name: "demo" },
      });
      expect(result.structuredContent).toEqual({ ok: true });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/mcp-servers/demo",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  it("exposes the put with writes and the delete only with dangerous", async () => {
    const names = async (env: Record<string, string>): Promise<string[]> =>
      withClient(env, async (client) => (await client.listTools()).tools.map((t) => t.name));
    const read = await names(adminEnv);
    expect(read).not.toContain("admin_put_mcp_server");
    expect(read).not.toContain("admin_delete_mcp_server");
    const writes = await names(writesEnv);
    expect(writes).toContain("admin_put_mcp_server");
    expect(writes).not.toContain("admin_delete_mcp_server");
    const dangerous = await names(dangerousEnv);
    expect(dangerous).toContain("admin_put_mcp_server");
    expect(dangerous).toContain("admin_delete_mcp_server");
    await withClient(dangerousEnv, async (client) => {
      const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
      expect(tools.get("admin_put_mcp_server")?.annotations?.destructiveHint).toBe(false);
      expect(tools.get("admin_delete_mcp_server")?.annotations?.destructiveHint).toBe(true);
    });
  });

  it("has exactly the writable fields of session-core's McpServerConfig", () => {
    // Fails to compile when the type gains or loses a field.
    const fields: Record<Exclude<keyof McpServerConfig, "name" | "transport">, true> = {
      url: true,
      enabled: true,
      readOnly: true,
      timeoutMs: true,
      maxOutputBytes: true,
      onecliSecret: true,
    };
    expect(Object.keys(MCP_SERVER_SHAPE).sort()).toEqual(Object.keys(fields).sort());
    for (const [key, field] of Object.entries(MCP_SERVER_SHAPE)) {
      expect(field.description, key).toBeTruthy();
    }
    expect(MCP_SERVER_SHAPE.maxOutputBytes.safeParse(MAX_MCP_OUTPUT_BYTES).success).toBe(true);
    expect(MCP_SERVER_SHAPE.maxOutputBytes.safeParse(MAX_MCP_OUTPUT_BYTES + 1).success).toBe(false);
  });

  it("validates arguments before any request", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(dangerousEnv, async (client) => {
      const bad: [string, Record<string, unknown>][] = [
        [
          "admin_put_mcp_server",
          { name: "history", expectedRevision: 0, url: "https://x.test", readOnly: true },
        ],
        [
          "admin_put_mcp_server",
          { name: "demo", expectedRevision: -1, url: "https://x.test", readOnly: true },
        ],
        ["admin_put_mcp_server", { name: "demo", expectedRevision: 0, readOnly: true }],
        ["admin_put_mcp_server", { name: "demo", expectedRevision: 0, url: "https://x.test" }],
        [
          "admin_put_mcp_server",
          {
            name: "demo",
            expectedRevision: 0,
            url: "https://x.test",
            readOnly: true,
            timeoutMs: 999,
          },
        ],
        [
          "admin_put_mcp_server",
          {
            name: "demo",
            expectedRevision: 0,
            url: "https://x.test",
            readOnly: true,
            maxOutputBytes: 24577,
          },
        ],
        [
          "admin_put_mcp_server",
          {
            name: "demo",
            expectedRevision: 0,
            url: "https://x.test",
            readOnly: true,
            onecliSecret: "a b",
          },
        ],
        ["admin_delete_mcp_server", { name: "demo", expectedRevision: 0 }],
        ["admin_delete_mcp_server", { name: "../x", expectedRevision: 1 }],
      ];
      for (const [name, args] of bad) {
        expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe("against the fake API", () => {
    let api: FakeApi;
    beforeEach(async () => {
      api = await FakeApi.start();
    });
    afterEach(async () => {
      await api.close();
    });
    const env = (): Record<string, string> => ({
      ...dangerousEnv,
      PI_API_URL: api.url,
      PI_API_TOKEN: api.token,
      PI_API_ADMIN_TOKEN: api.adminToken,
    });

    it("sends the put body and the delete query", async () => {
      api.onAdmin("PUT", "/admin/mcp-servers/demo", { status: 201, body: { revision: 1 } });
      api.onAdmin("DELETE", "/admin/mcp-servers/demo", { body: { name: "demo", deleted: true } });
      await withClient(env(), async (client) => {
        const put = await client.callTool({
          name: "admin_put_mcp_server",
          arguments: {
            name: "demo",
            expectedRevision: 0,
            url: "https://mcp.example.test/",
            readOnly: true,
            onecliSecret: null,
          },
        });
        expect(put.structuredContent).toEqual({ revision: 1 });
        const del = await client.callTool({
          name: "admin_delete_mcp_server",
          arguments: { name: "demo", expectedRevision: 3 },
        });
        expect(del.structuredContent).toEqual({ name: "demo", deleted: true });
      });
      expect(api.adminRequests.map((r) => [r.method, r.path])).toEqual([
        ["PUT", "/admin/mcp-servers/demo"],
        ["DELETE", "/admin/mcp-servers/demo"],
      ]);
      expect(api.adminRequests[0]?.body).toEqual({
        expectedRevision: 0,
        url: "https://mcp.example.test/",
        readOnly: true,
        onecliSecret: null,
      });
      expect(api.adminRequests[1]?.query).toEqual({ expectedRevision: "3" });
    });

    it("passes a 409 through as an error result", async () => {
      api.onAdmin("PUT", "/admin/mcp-servers/demo", {
        status: 409,
        body: { error: "revision conflict" },
      });
      api.onAdmin("DELETE", "/admin/mcp-servers/demo", {
        status: 409,
        body: { error: "blocked", blockedBy: ["coding"] },
      });
      await withClient(env(), async (client) => {
        const put = await client.callTool({
          name: "admin_put_mcp_server",
          arguments: { name: "demo", expectedRevision: 1, url: "https://x.test", readOnly: false },
        });
        expect(put.isError).toBe(true);
        expect(put.structuredContent).toMatchObject({ status: 409 });
        const del = await client.callTool({
          name: "admin_delete_mcp_server",
          arguments: { name: "demo", expectedRevision: 1 },
        });
        expect(del.isError).toBe(true);
        expect(del.structuredContent).toMatchObject({ status: 409 });
      });
    });
  });
});
