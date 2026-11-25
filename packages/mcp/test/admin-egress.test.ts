import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEnv, withClient } from "./admin-fixture.js";

describe("admin egress tools", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the name of admin_get_egress_rule_set before making a request", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      const valid = await client.callTool({
        name: "admin_get_egress_rule_set",
        arguments: { name: "a".repeat(32) },
      });
      expect(valid.isError).not.toBe(true);
      const invalid = await client.callTool({
        name: "admin_get_egress_rule_set",
        arguments: { name: "a".repeat(33) },
      });
      expect(invalid.isError).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("lists and gets from /admin/egress/rule-sets", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      await client.callTool({ name: "admin_list_egress_rule_sets", arguments: {} });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/egress/rule-sets",
        expect.objectContaining({ method: "GET" }),
      );
      const result = await client.callTool({
        name: "admin_get_egress_rule_set",
        arguments: { name: "demo" },
      });
      expect(result.structuredContent).toEqual({ ok: true });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/egress/rule-sets/demo",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
