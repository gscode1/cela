import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEnv, withClient } from "./admin-fixture.js";

describe("admin skill tools", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the name of admin_get_skill before making a request", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      const valid = await client.callTool({
        name: "admin_get_skill",
        arguments: { name: "a".repeat(64) },
      });
      expect(valid.isError).not.toBe(true);
      const invalid = await client.callTool({
        name: "admin_get_skill",
        arguments: { name: "a".repeat(65) },
      });
      expect(invalid.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("lists and gets from /admin/skills", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      await client.callTool({ name: "admin_list_skills", arguments: {} });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/skills",
        expect.objectContaining({ method: "GET" }),
      );
      const result = await client.callTool({
        name: "admin_get_skill",
        arguments: { name: "demo" },
      });
      expect(result.structuredContent).toEqual({ ok: true });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/skills/demo",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
