import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@cela/session-core";
import { SETTINGS_SHAPE } from "../src/admin/settings.js";
import { adminEnv, dangerousEnv, withClient, writesEnv } from "./admin-fixture.js";

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

  it("has exactly the fields of session-core's Settings", () => {
    // `Record<keyof Settings, true>` fails to compile when the type gains or loses a field.
    const fields: Record<keyof Settings, true> = {
      defaultModel: true,
      allowlist: true,
      reasoning: true,
      maxReasoning: true,
      defaultProfile: true,
      turnBudget: true,
      tokenBudget: true,
      repoAllowlist: true,
    };
    expect(Object.keys(SETTINGS_SHAPE).sort()).toEqual(Object.keys(fields).sort());
    for (const [key, field] of Object.entries(SETTINGS_SHAPE)) {
      expect(field.description, key).toBeTruthy();
    }
  });

  it("exposes the put only with the dangerous flag", async () => {
    for (const [env, put] of [
      [adminEnv, false],
      [writesEnv, false],
      [dangerousEnv, true],
    ] as const) {
      await withClient(env, async (client) => {
        const tools = (await client.listTools()).tools;
        expect(tools.some((tool) => tool.name === "admin_get_settings")).toBe(true);
        const tool = tools.find((entry) => entry.name === "admin_put_settings");
        expect(tool !== undefined).toBe(put);
        if (tool !== undefined) expect(tool.annotations?.destructiveHint).toBe(true);
      });
    }
  });

  it("puts the settings as sent, the revision in the body", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ revision: 5 }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetcher);
    await withClient(dangerousEnv, async (client) => {
      const args = {
        expectedRevision: 4,
        defaultModel: "anthropic/claude-sonnet-5-5",
        allowlist: ["anthropic/claude-sonnet-5-5"],
        reasoning: null,
        maxReasoning: "high",
        defaultProfile: "coding",
        turnBudget: 50,
        tokenBudget: null,
        repoAllowlist: ["acme/*"],
      };
      const result = await client.callTool({ name: "admin_put_settings", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ revision: 5 });
      expect(fetcher).toHaveBeenCalledWith(
        "https://example.test/admin/settings",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(args),
        }),
      );
      // A patch: omitted fields are not sent.
      await client.callTool({
        name: "admin_put_settings",
        arguments: { expectedRevision: 5, turnBudget: 10 },
      });
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://example.test/admin/settings",
        expect.objectContaining({ body: JSON.stringify({ expectedRevision: 5, turnBudget: 10 }) }),
      );
    });
  });

  it("refuses bad arguments before making a request, and passes unknown fields to ingest", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetcher);
    await withClient(dangerousEnv, async (client) => {
      const put = (args: Record<string, unknown>) =>
        client.callTool({ name: "admin_put_settings", arguments: args });
      expect((await put({})).isError).toBe(true);
      expect((await put({ expectedRevision: 0 })).isError).toBe(true);
      expect((await put({ expectedRevision: 1.5 })).isError).toBe(true);
      expect((await put({ expectedRevision: 1, reasoning: "extreme" })).isError).toBe(true);
      expect((await put({ expectedRevision: 1, allowlist: "a/b" })).isError).toBe(true);
      expect((await put({ expectedRevision: 1, turnBudget: "5" })).isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      await put({ expectedRevision: 1, futureField: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    [409, "settings revision is 6, not 4"],
    [400, "unknown setting revision"],
  ])("passes a %i from ingest on, scrubbed and labelled untrusted", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `${message} admin-secret` }), { status }),
        ),
      ),
    );
    await withClient(dangerousEnv, async (client) => {
      const result = await client.callTool({
        name: "admin_put_settings",
        arguments: { expectedRevision: 4, turnBudget: 5 },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(String(status));
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).toContain("untrusted");
      expect(JSON.stringify(result)).not.toContain("admin-secret");
    });
  });
});
