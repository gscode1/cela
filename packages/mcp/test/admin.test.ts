import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const base = { PI_API_URL: "https://example.test", PI_API_TOKEN: "session-secret" };

describe("admin mode", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires explicit flags and a separate token", () => {
    expect(parseConfig(base).admin).toBeUndefined();
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN: "true" })).toThrow("PI_API_ADMIN_TOKEN");
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN_WRITES: "true" })).toThrow("PI_MCP_ADMIN");
    expect(() => parseConfig({ ...base, PI_MCP_ADMIN: "yes" })).toThrow("PI_MCP_ADMIN");
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
    const config = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
      PI_MCP_ADMIN_WRITES: "true",
    });
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
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
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("validates each catalog name and profile writes before making requests", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    const config = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
      PI_MCP_ADMIN_WRITES: "true",
    });
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      for (const tool of [
        "admin_get_profiles",
        "admin_get_mcp_servers",
        "admin_get_egress_rule_sets",
        "admin_get_skills",
      ]) {
        const max = tool === "admin_get_skills" ? 64 : 32;
        const valid = await client.callTool({ name: tool, arguments: { name: "a".repeat(max) } });
        expect(valid.isError).not.toBe(true);
        const invalid = await client.callTool({
          name: tool,
          arguments: { name: "a".repeat(max + 1) },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
      for (const tool of ["admin_put_profile", "admin_delete_profile"]) {
        const invalid = await client.callTool({
          name: tool,
          arguments: { name: "a".repeat(33), expectedRevision: 1 },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([false, true])("exposes reads and gates writes (writes=%s)", async (writes) => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ revision: 2, value: "admin-secret" }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const config = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
      PI_MCP_ADMIN_WRITES: String(writes),
    });
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.filter((tool) => tool.name.startsWith("admin_")).length).toBe(writes ? 11 : 9);
      expect(tools.some((tool) => tool.name === "admin_put_profile")).toBe(writes);
      const result = await client.callTool({
        name: "admin_get_profiles",
        arguments: { name: "coding" },
      });
      expect(JSON.stringify(result)).not.toContain("admin-secret");
      expect(fetcher).toHaveBeenCalledWith(
        "https://example.test/admin/profiles/coding",
        expect.objectContaining({
          redirect: "error",
          headers: { authorization: "Bearer admin-secret" },
        }),
      );
      if (writes) {
        await client.callTool({
          name: "admin_put_profile",
          arguments: { name: "coding", expectedRevision: 2, definition: {} },
        });
        expect(fetcher).toHaveBeenLastCalledWith(
          "https://example.test/admin/profiles/coding",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ expectedRevision: 2, definition: {} }),
          }),
        );
        await client.callTool({
          name: "admin_delete_profile",
          arguments: { name: "coding", expectedRevision: 2 },
        });
        expect(fetcher).toHaveBeenLastCalledWith(
          "https://example.test/admin/profiles/coding?expectedRevision=2",
          expect.objectContaining({ method: "DELETE" }),
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
