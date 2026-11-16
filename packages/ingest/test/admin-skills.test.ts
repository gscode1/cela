import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SettingsCache, seedSettings } from "@pi-durable-k8s/session-core";
import type { Settings } from "@pi-durable-k8s/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

const seed: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
};

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(): Promise<{ base: string; db: FakeSettingsDb }> {
  const db = new FakeSettingsDb();
  await seedSettings(db.asPool(), seed);
  cache = new SettingsCache(db.asPool(), { pollMs: 60_000 });
  await cache.start();
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: "http://unused",
    settings: cache,
    admins: ["alice"],
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, db };
}

const call = (
  base: string,
  who: string | undefined,
  method: string,
  path: string,
  body?: unknown,
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(who === undefined ? {} : { authorization: `Bearer ${who}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const PDF = {
  description: "Summarise a PDF",
  files: [
    { path: "SKILL.md", content: "# PDF\nRun scripts/run.sh" },
    { path: "scripts/run.sh", content: "echo hi\n", executable: true },
  ],
};

describe("admin skills authorization", () => {
  it("answers 401 without a token and 403 to a non-admin on every route, and nothing is written", async () => {
    const { base, db } = await start();
    const routes: [string, string, unknown?][] = [
      ["GET", "/admin/skills"],
      ["GET", "/admin/skills/pdf"],
      ["POST", "/admin/skills/pdf/versions", PDF],
      ["GET", "/admin/skills/pdf/versions/1"],
      ["DELETE", "/admin/skills/pdf"],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(base, undefined, method, path, body)).status, `${method} ${path}`).toBe(
        401,
      );
      expect((await call(base, "bob", method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(db.skills.size).toBe(0);
    expect(db.skillVersions).toHaveLength(0);
    expect(db.skillFiles).toHaveLength(0);
  });
});

describe("admin skills", () => {
  it("publishes v1 (201), repeats it as a no-op (200), publishes v2 on a change, and lists them", async () => {
    const { base, db } = await start();
    const first = await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    expect(first.status).toBe(201);
    const v1 = await json(first);
    expect(v1).toMatchObject({
      name: "pdf",
      version: 1,
      versionCreated: true,
      createdBy: "alice",
      description: "Summarise a PDF",
    });
    expect(v1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.files).toEqual([
      expect.objectContaining({ path: "SKILL.md", executable: false }),
      expect.objectContaining({ path: "scripts/run.sh", executable: true }),
    ]);
    const again = await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ version: 1, versionCreated: false });
    const second = await call(base, "alice", "POST", "/admin/skills/pdf/versions", {
      ...PDF,
      description: "Summarise PDFs",
    });
    expect(second.status).toBe(201);
    expect(await json(second)).toMatchObject({ version: 2 });
    expect(db.skillVersions).toHaveLength(2);

    const list = await json(await call(base, "alice", "GET", "/admin/skills"));
    expect(list.skills).toEqual([
      expect.objectContaining({ name: "pdf", currentVersion: 2, description: "Summarise PDFs" }),
    ]);
    const one = await json(await call(base, "alice", "GET", "/admin/skills/pdf"));
    expect(one).toMatchObject({ name: "pdf", currentVersion: 2 });
    expect((one.versions as { version: number }[]).map((v) => v.version)).toEqual([2, 1]);
  });

  it("returns a version's metadata, its bytes with ?content=true, and 404 for what does not exist", async () => {
    const { base } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    const meta = await json(await call(base, "alice", "GET", "/admin/skills/pdf/versions/1"));
    expect(meta).toMatchObject({ version: 1 });
    expect(JSON.stringify(meta)).not.toContain("contentBase64");
    const full = await json(
      await call(base, "alice", "GET", "/admin/skills/pdf/versions/1?content=true"),
    );
    const files = full.files as { path: string; contentBase64: string }[];
    expect(Buffer.from(files[0]?.contentBase64 ?? "", "base64").toString()).toContain("# PDF");
    expect((await call(base, "alice", "GET", "/admin/skills/pdf/versions/9")).status).toBe(404);
    expect((await call(base, "alice", "GET", "/admin/skills/nope")).status).toBe(404);
    expect((await call(base, "alice", "GET", "/admin/skills/pdf/versions/abc")).status).toBe(400);
    expect((await call(base, "alice", "GET", "/admin/skills/Bad_Name")).status).toBe(400);
  });

  it("refuses traversal, symlink-shaped input, duplicates and oversize with 400 and writes nothing", async () => {
    const { base, db } = await start();
    const publish = (body: unknown) =>
      call(base, "alice", "POST", "/admin/skills/pdf/versions", body);
    const skillMd = { path: "SKILL.md", content: "x" };
    for (const files of [
      [skillMd, { path: "../escape", content: "x" }],
      [skillMd, { path: "/abs", content: "x" }],
      [skillMd, { path: "link", content: "x", symlink: "/etc/passwd" }],
      [skillMd, { path: "a", content: "x" }, { path: "a", content: "y" }],
      [{ path: "SKILL.md", content: "x".repeat(32 * 1024 + 1) }],
      [skillMd, { path: "big", content: "x".repeat(5 * 1024 * 1024 + 1) }],
    ]) {
      const response = await publish({ description: "d", files });
      expect(response.status, JSON.stringify(files).slice(0, 60)).toBe(400);
    }
    expect((await publish({ description: "d" })).status).toBe(400);
    expect((await publish({ description: "d\u0000", files: [skillMd] })).status).toBe(400);
    expect(db.skills.size).toBe(0);
    expect(db.skillFiles).toHaveLength(0);
  });

  it("has no delete and no update of a version", async () => {
    const { base } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    expect((await call(base, "alice", "DELETE", "/admin/skills/pdf")).status).toBe(405);
    expect((await call(base, "alice", "PUT", "/admin/skills/pdf/versions/1", PDF)).status).toBe(
      405,
    );
    expect((await call(base, "alice", "DELETE", "/admin/skills/pdf/versions/1")).status).toBe(405);
    expect((await call(base, "alice", "GET", "/admin/skills/pdf/files")).status).toBe(404);
  });
});

describe("profiles with skills and sessions", () => {
  it("a profile pins the version and digest, a session snapshots them, and v2 leaves the session on v1", async () => {
    const { base, db } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    const digest = db.skillVersions[0]?.digest;
    const put = await call(base, "alice", "PUT", "/admin/profiles/docs", {
      definition: { skills: [{ name: "pdf", version: 1 }] },
    });
    expect(put.status).toBe(201);
    expect((await json(put)).definition).toEqual({ skills: [{ name: "pdf", version: 1, digest }] });

    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "docs" }));
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", { ...PDF, description: "new" });
    const got = await json(
      await call(base, "bob", "GET", `/sessions/${String(created.sessionId)}`),
    );
    expect(got.skills).toEqual([{ name: "pdf", version: 1, digest }]);

    const plain = await json(await call(base, "bob", "POST", "/sessions", {}));
    const gotPlain = await json(
      await call(base, "bob", "GET", `/sessions/${String(plain.sessionId)}`),
    );
    expect(gotPlain.skills).toBeUndefined();
  });

  it("refuses a profile naming a skill version that does not exist, or one that needs read without it", async () => {
    const { base } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    const missing = await call(base, "alice", "PUT", "/admin/profiles/docs", {
      definition: { skills: [{ name: "pdf", version: 2 }] },
    });
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toContain("does not exist");
    const noRead = await call(base, "alice", "PUT", "/admin/profiles/docs", {
      definition: { tools: ["bash"], skills: [{ name: "pdf", version: 1 }] },
    });
    expect(noRead.status).toBe(400);
    expect((await json(noRead)).error).toContain("read tool");
  });
});
