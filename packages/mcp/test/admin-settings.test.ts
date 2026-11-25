import { afterEach, describe, expect, it, vi } from "vitest";
import { adminEnv, withClient } from "./admin-fixture.js";

describe("admin settings tools", { timeout: 10_000 }, () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a redirect and a non-JSON answer without leaking either token", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      return Promise.resolve(new Response("<html>admin-secret</html>", { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      const result = await client.callTool({ name: "admin_get_settings", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not JSON");
      expect(JSON.stringify(result)).not.toContain("admin-secret");
    });
  });

  it("gets the settings from /admin/settings", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ revision: 4 }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(adminEnv, async (client) => {
      const result = await client.callTool({ name: "admin_get_settings", arguments: {} });
      expect(result.structuredContent).toEqual({ revision: 4 });
      expect(fetcher).toHaveBeenCalledWith(
        "https://example.test/admin/settings",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
