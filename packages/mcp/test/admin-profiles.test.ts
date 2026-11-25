import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileDefinition } from "@cela/session-core";
import { PROFILE_DEFINITION_SHAPE } from "../src/admin/profiles.js";
import { adminEnv, withClient, writesEnv } from "./admin-fixture.js";

describe("admin profile tools", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the profile name and writes before making requests", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(writesEnv, async (client) => {
      const valid = await client.callTool({
        name: "admin_get_profile",
        arguments: { name: "a".repeat(32) },
      });
      expect(valid.isError).not.toBe(true);
      const invalid = await client.callTool({
        name: "admin_get_profile",
        arguments: { name: "a".repeat(33) },
      });
      expect(invalid.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      for (const tool of ["admin_put_profile", "admin_delete_profile"]) {
        const invalid = await client.callTool({
          name: tool,
          arguments: { name: "a".repeat(33), expectedRevision: 1 },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes the profile writes only with the writes flag", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ revision: 2, value: "admin-secret" }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(writesEnv, async (client) => {
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
    });
    await withClient(adminEnv, async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.some((tool) => tool.name === "admin_put_profile")).toBe(false);
      expect(tools.some((tool) => tool.name === "admin_delete_profile")).toBe(false);
    });
  });

  it("marks the put as a write and the delete as destructive", async () => {
    await withClient(writesEnv, async (client) => {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      expect(tools.get("admin_put_profile")?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tools.get("admin_delete_profile")?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(tools.get("admin_get_profile")?.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    });
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
    await withClient(adminEnv, async (client) => {
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
    });
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
    await withClient(adminEnv, async (client) => {
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
    });
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
      sandboxRuntime: true,
      contextTrim: true,
    };
    expect(Object.keys(PROFILE_DEFINITION_SHAPE).sort()).toEqual(Object.keys(fields).sort());
    for (const [key, field] of Object.entries(PROFILE_DEFINITION_SHAPE)) {
      expect(field.description, key).toBeTruthy();
    }
  });

  it("accepts the desktop sandbox flavour", () => {
    expect(PROFILE_DEFINITION_SHAPE.sandboxFlavour.safeParse("desktop").success).toBe(true);
    expect(PROFILE_DEFINITION_SHAPE.sandboxFlavour.safeParse("gpu").success).toBe(false);
  });

  it("types the known fields and passes unknown ones on for ingest to judge", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(writesEnv, async (client) => {
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
    });
  });
});
