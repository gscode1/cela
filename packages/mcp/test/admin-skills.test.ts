import { SKILL_BODY_LIMIT as INGEST_BODY_LIMIT } from "@cela/session-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { CONTENT_CAP, SKILL_BODY_LIMIT } from "../src/admin/skills.js";
import { adminEnv, dangerousEnv, withClient, writesEnv } from "./admin-fixture.js";
import { FakeApi } from "./fake-api.js";

const b64 = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64");

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

  it("keeps the body limit equal to ingest's", () => {
    expect(SKILL_BODY_LIMIT).toBe(INGEST_BODY_LIMIT);
  });

  it("exposes publish with the writes flag and delete with the dangerous flag", async () => {
    for (const [env, publish, remove] of [
      [adminEnv, false, false],
      [writesEnv, true, false],
      [dangerousEnv, true, true],
    ] as const) {
      await withClient(env, async (client) => {
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
        expect(tools.has("admin_get_skill_version")).toBe(true);
        expect(tools.has("admin_publish_skill")).toBe(publish);
        expect(tools.has("admin_delete_skill")).toBe(remove);
        expect(tools.get("admin_get_skill_version")?.annotations?.readOnlyHint).toBe(true);
        if (publish)
          expect(tools.get("admin_publish_skill")?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
          });
        if (remove)
          expect(tools.get("admin_delete_skill")?.annotations?.destructiveHint).toBe(true);
      });
    }
  });
});

describe("admin skill tools against a fake API", { timeout: 10_000 }, () => {
  let fake: FakeApi;
  beforeEach(async () => {
    fake = await FakeApi.start();
  });
  afterEach(async () => {
    await fake.close();
  });

  const run = <T>(
    flags: Record<string, string>,
    body: (client: Client) => Promise<T>,
  ): Promise<T> =>
    withClient(
      {
        ...dangerousEnv,
        ...flags,
        PI_API_URL: fake.url,
        PI_API_TOKEN: fake.token,
        PI_API_ADMIN_TOKEN: fake.adminToken,
      },
      body,
    );
  const call = (client: Client, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });

  describe("admin_get_skill_version", () => {
    const manifest = (path: string, bytes: Buffer) => ({
      path,
      size: bytes.length,
      sha256: "0".repeat(64),
      executable: false,
      contentBase64: b64(bytes),
    });

    it("sends content=true only when asked and returns the manifest without content", async () => {
      fake.onAdmin("GET", "/admin/skills/demo/versions/2", {
        body: { name: "demo", version: 2, files: [{ path: "SKILL.md", size: 3 }] },
      });
      await run({}, async (client) => {
        const result = await call(client, "admin_get_skill_version", { name: "demo", version: 2 });
        expect(result.structuredContent).toEqual({
          name: "demo",
          version: 2,
          files: [{ path: "SKILL.md", size: 3 }],
        });
        expect(fake.adminRequests.at(-1)).toMatchObject({ query: {} });
        await call(client, "admin_get_skill_version", { name: "demo", version: 2, content: true });
        expect(fake.adminRequests.at(-1)?.query).toEqual({ content: "true" });
      });
    });

    it("decodes UTF-8 text, keeps binary as base64, filters by paths", async () => {
      const text = Buffer.from("﻿# Skill é世\n");
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
      const withNul = Buffer.from("a\u0000b");
      fake.onAdmin("GET", "/admin/skills/demo/versions/1", {
        body: {
          version: 1,
          files: [
            manifest("SKILL.md", text),
            manifest("bin/tool", binary),
            manifest("nul.txt", withNul),
            manifest("other.md", Buffer.from("x")),
          ],
        },
      });
      await run({}, async (client) => {
        const all = (
          await call(client, "admin_get_skill_version", {
            name: "demo",
            version: 1,
            content: true,
          })
        ).structuredContent as { files: Record<string, unknown>[]; truncated?: boolean };
        expect(all.truncated).toBeUndefined();
        expect(all.files[0]).toMatchObject({ path: "SKILL.md", content: text.toString() });
        expect(all.files[0]).not.toHaveProperty("contentBase64");
        expect(all.files[1]).toMatchObject({ path: "bin/tool", contentBase64: b64(binary) });
        expect(all.files[1]).not.toHaveProperty("content");
        expect(all.files[2]).toMatchObject({ contentBase64: b64(withNul) });

        const some = (
          await call(client, "admin_get_skill_version", {
            name: "demo",
            version: 1,
            content: true,
            paths: ["other.md", "bin/tool"],
          })
        ).structuredContent as { files: { path: string }[] };
        expect(some.files.map((file) => file.path)).toEqual(["bin/tool", "other.md"]);
      });
    });

    it("scrubs tokens in decoded content", async () => {
      fake.onAdmin("GET", "/admin/skills/demo/versions/1", {
        body: {
          files: [manifest("SKILL.md", Buffer.from(`key ${fake.adminToken} ${fake.token}`))],
        },
      });
      await run({}, async (client) => {
        const result = await call(client, "admin_get_skill_version", {
          name: "demo",
          version: 1,
          content: true,
        });
        expect(JSON.stringify(result)).not.toContain(fake.adminToken);
        expect(JSON.stringify(result)).not.toContain(fake.token);
        expect(result.structuredContent).toMatchObject({
          files: [{ content: "key [redacted] [redacted]" }],
        });
      });
    });

    it("caps the content and marks truncated, listing later files without content", async () => {
      const big = Buffer.alloc(CONTENT_CAP - 10, "a");
      fake.onAdmin("GET", "/admin/skills/demo/versions/1", {
        body: {
          files: [
            manifest("a.txt", big),
            manifest("b.txt", Buffer.alloc(11, "b")),
            manifest("c.txt", Buffer.alloc(10, "c")),
          ],
        },
      });
      await run({}, async (client) => {
        const result = (
          await call(client, "admin_get_skill_version", { name: "demo", version: 1, content: true })
        ).structuredContent as { files: Record<string, unknown>[]; truncated?: boolean };
        expect(result.truncated).toBe(true);
        expect(result.files[0]).toHaveProperty("content");
        expect(result.files[1]).toMatchObject({ path: "b.txt" });
        expect(result.files[1]).not.toHaveProperty("content");
        expect(result.files[1]).not.toHaveProperty("contentBase64");
        expect(result.files[2]).toMatchObject({ content: "c".repeat(10) });
      });
    });

    it("validates arguments and passes API errors through", async () => {
      await run({}, async (client) => {
        for (const args of [
          { name: "Demo", version: 1 },
          { name: "demo", version: 0 },
          { name: "demo", version: 1.5 },
        ])
          expect((await call(client, "admin_get_skill_version", args)).isError).toBe(true);
        expect(fake.adminRequests).toHaveLength(0);
        const missing = await call(client, "admin_get_skill_version", { name: "demo", version: 3 });
        expect(missing.isError).toBe(true);
        expect(missing.structuredContent).toMatchObject({ status: 404 });
      });
    });
  });

  describe("admin_publish_skill", () => {
    const files = [{ path: "SKILL.md", content: "---\ndescription: d\n---\nbody" }];

    it("posts the files and source to ingest and returns its answer", async () => {
      const answer = { name: "demo", version: 1, digest: "d".repeat(64), versionCreated: true };
      fake.onAdmin("POST", "/admin/skills/demo/versions", { status: 201, body: answer });
      await run({}, async (client) => {
        const source = { repository: "github.com/acme/catalog", commit: "abcdef1" };
        const result = await call(client, "admin_publish_skill", {
          name: "demo",
          files: [...files, { path: "run.sh", contentBase64: b64("#!/bin/sh"), executable: true }],
          source,
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(answer);
        expect(fake.adminRequests).toEqual([
          {
            method: "POST",
            path: "/admin/skills/demo/versions",
            query: {},
            body: {
              files: [
                ...files,
                { path: "run.sh", contentBase64: b64("#!/bin/sh"), executable: true },
              ],
              source,
            },
          },
        ]);
      });
    });

    it("refuses invalid input before sending anything", async () => {
      await run({}, async (client) => {
        const bad: Record<string, unknown>[] = [
          { name: "Demo", files },
          { name: "demo", files: [] },
          { name: "demo", files: [{ path: "SKILL.md" }] },
          { name: "demo", files: [{ path: "SKILL.md", content: "x", contentBase64: "eA==" }] },
          { name: "demo", files: [{ path: "", content: "x" }] },
          {
            name: "demo",
            files: Array.from({ length: 129 }, (_, index) => ({
              path: `f${String(index)}`,
              content: "x",
            })),
          },
          { name: "demo", files, source: { repository: "r", commit: "XYZ" } },
        ];
        for (const args of bad)
          expect((await call(client, "admin_publish_skill", args)).isError).toBe(true);
        expect(fake.adminRequests).toHaveLength(0);
      });
    });

    it("accepts 128 files", async () => {
      fake.onAdmin("POST", "/admin/skills/demo/versions", { status: 201, body: { version: 1 } });
      await run({}, async (client) => {
        const result = await call(client, "admin_publish_skill", {
          name: "demo",
          files: Array.from({ length: 128 }, (_, index) => ({
            path: `f${String(index)}`,
            content: "x",
          })),
        });
        expect(result.isError).not.toBe(true);
        expect(fake.adminRequests).toHaveLength(1);
      });
    });

    it("refuses a body over the ingest limit without sending it", async () => {
      await run({}, async (client) => {
        const result = await call(client, "admin_publish_skill", {
          name: "demo",
          files: [{ path: "big.txt", content: "a".repeat(SKILL_BODY_LIMIT + 1) }],
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 413 });
        expect(fake.adminRequests).toHaveLength(0);
        expect(fake.requests).toHaveLength(0);
      });
    });

    it("passes an ingest 400 through as an error", async () => {
      fake.onAdmin("POST", "/admin/skills/demo/versions", {
        status: 400,
        body: { error: "SKILL.md needs a description" },
      });
      await run({}, async (client) => {
        const result = await call(client, "admin_publish_skill", { name: "demo", files });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          error: "SKILL.md needs a description",
          status: 400,
        });
      });
    });

    it("waits longer than the default 30 s timeout", async () => {
      const timeouts: number[] = [];
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        timeouts.push(ms);
        return timeout(ms);
      });
      fake.onAdmin("POST", "/admin/skills/demo/versions", { status: 201, body: { version: 1 } });
      await run({}, async (client) => {
        await call(client, "admin_publish_skill", { name: "demo", files });
      });
      expect(timeouts).toContain(120_000);
      vi.restoreAllMocks();
    });
  });

  describe("admin_delete_skill", () => {
    it("deletes at the expected revision", async () => {
      fake.onAdmin("DELETE", "/admin/skills/demo", {
        body: { name: "demo", deleted: true, lastVersion: 3 },
      });
      await run({}, async (client) => {
        const result = await call(client, "admin_delete_skill", {
          name: "demo",
          expectedRevision: 3,
        });
        expect(result.structuredContent).toEqual({ name: "demo", deleted: true, lastVersion: 3 });
        expect(fake.adminRequests).toEqual([
          {
            method: "DELETE",
            path: "/admin/skills/demo",
            query: { expectedRevision: "3" },
            body: undefined,
          },
        ]);
      });
    });

    it("validates arguments and returns a blocked 409", async () => {
      fake.onAdmin("DELETE", "/admin/skills/demo", {
        status: 409,
        body: {
          error: "skill is in use",
          blockedBy: { profiles: [{ name: "coding", version: 4 }] },
        },
      });
      await run({}, async (client) => {
        for (const args of [
          { name: "Demo", expectedRevision: 1 },
          { name: "demo", expectedRevision: 0 },
          { name: "demo" },
        ])
          expect((await call(client, "admin_delete_skill", args)).isError).toBe(true);
        expect(fake.adminRequests).toHaveLength(0);
        const blocked = await call(client, "admin_delete_skill", {
          name: "demo",
          expectedRevision: 1,
        });
        expect(blocked.isError).toBe(true);
        expect(blocked.structuredContent).toMatchObject({
          status: 409,
          error: "skill is in use",
        });
      });
    });
  });
});
