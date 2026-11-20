import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileDefinition } from "@cela/session-core";
import { PROFILE_DEFINITION_SHAPE } from "../src/admin.js";
import { parseConfig } from "../src/config.js";
import { createServer, serverInstructions } from "../src/server.js";

const base = { PI_API_URL: "https://example.test", PI_API_TOKEN: "session-secret" };

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
        "admin_get_profile",
        "admin_get_mcp_server",
        "admin_get_egress_rule_set",
        "admin_get_skill",
      ]) {
        const max = tool === "admin_get_skill" ? 64 : 32;
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

  it("refuses a redirect and a non-JSON answer without leaking either token", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return Promise.resolve(new Response("<html>admin-secret</html>", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const config = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
    });
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({ name: "admin_get_settings", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not JSON");
      expect(JSON.stringify(result)).not.toContain("admin-secret");
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
        name: "admin_get_profile",
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

  it("admin_get_profile trims versions in the adapter", async () => {
    const body = {
      name: "coding",
      revision: 3,
      versions: [{ version: 3 }, { version: 2 }, { version: 1 }],
    };
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    const config = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
    });
    const server = createServer(config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const get = async (versions?: number): Promise<Record<string, unknown>> =>
        (
          await client.callTool({
            name: "admin_get_profile",
            arguments: { name: "coding", ...(versions === undefined ? {} : { versions }) },
          })
        ).structuredContent as Record<string, unknown>;
      expect((await get()).versions).toHaveLength(3);
      expect((await get(2)).versions).toEqual([{ version: 3 }, { version: 2 }]);
      expect((await get(0)).versions).toEqual([]);
      expect((await get(2)).revision).toBe(3);
      const bad = await client.callTool({
        name: "admin_get_profile",
        arguments: { name: "coding", versions: -1 },
      });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("points to the admin tools for discovery only when they exist", () => {
    const admin = parseConfig({
      ...base,
      PI_MCP_ADMIN: "true",
      PI_API_ADMIN_TOKEN: "admin-secret",
    });
    expect(serverInstructions(admin)).toContain("admin_list_profiles");
    expect(serverInstructions(admin)).toContain("admin_get_settings");
    expect(serverInstructions(admin).split(/\s+/).length).toBeLessThanOrEqual(250);
    expect(serverInstructions(parseConfig(base))).not.toContain("admin_");
  });

  it("admin_get_profile sends a version's definition only when it differs from the top-level one", async () => {
    const definition = { tools: ["read"], instructions: "x" };
    const body = {
      name: "coding",
      currentVersion: 2,
      definition,
      versions: [
        { version: 2, definition: { ...definition }, createdBy: "a" },
        { version: 1, definition: { tools: ["read", "bash"] }, createdBy: "a" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
    );
    const server = createServer(
      parseConfig({ ...base, PI_MCP_ADMIN: "true", PI_API_ADMIN_TOKEN: "admin-secret" }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "admin_get_profile",
        arguments: { name: "coding" },
      });
      expect(result.structuredContent).toMatchObject({
        definition,
        versions: [
          { version: 2, createdBy: "a" },
          { version: 1, definition: { tools: ["read", "bash"] } },
        ],
      });
      const versions = (result.structuredContent as { versions: object[] }).versions;
      expect(versions[0]).not.toHaveProperty("definition");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("admin_put_profile definition schema", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has exactly the fields of session-core's ProfileDefinition", () => {
    // `Record<keyof ProfileDefinition, true>` fails to compile when the type gains or loses a field.
    const fields: Record<keyof ProfileDefinition, true> = {
      tools: true,
      modelTools: true,
      instructions: true,
      defaultModel: true,
      reasoning: true,
      turnBudget: true,
      tokenBudget: true,
      mcpServers: true,
      skills: true,
      repoSkills: true,
      repoContext: true,
      sandboxSize: true,
      sandboxSizes: true,
      egressRuleSets: true,
      networkMode: true,
      sandboxFlavour: true,
    };
    expect(Object.keys(PROFILE_DEFINITION_SHAPE).sort()).toEqual(Object.keys(fields).sort());
    for (const [key, field] of Object.entries(PROFILE_DEFINITION_SHAPE)) {
      expect(field.description, key).toBeTruthy();
    }
  });

  it("types the known fields and passes unknown ones on for ingest to judge", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    const server = createServer(
      parseConfig({
        ...base,
        PI_MCP_ADMIN: "true",
        PI_API_ADMIN_TOKEN: "admin-secret",
        PI_MCP_ADMIN_WRITES: "true",
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const put = (definition: unknown) =>
        client.callTool({
          name: "admin_put_profile",
          arguments: { name: "coding", expectedRevision: 1, definition },
        });
      expect((await put({ tools: "read" })).isError).toBe(true);
      expect((await put({ reasoning: "extreme" })).isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      expect((await put({ tools: ["read"], futureField: 1 })).isError).toBeUndefined();
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/profiles/coding",
        expect.objectContaining({
          body: JSON.stringify({
            expectedRevision: 1,
            definition: { tools: ["read"], futureField: 1 },
          }),
        }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
