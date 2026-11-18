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
  tokenBudget: null,
  repoAllowlist: ["acme/widgets"],
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

const skillMd = (description: string, extra = "") =>
  `---\ndescription: ${description}\n${extra}---\n# PDF\nRun scripts/run.sh\n`;
const withDescription = (description: string) => ({
  files: [{ path: "SKILL.md", content: skillMd(description) }, ...PDF.files.slice(1)],
});
const PDF = {
  files: [
    { path: "SKILL.md", content: skillMd("Summarise a PDF") },
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
    const second = await call(
      base,
      "alice",
      "POST",
      "/admin/skills/pdf/versions",
      withDescription("Summarise PDFs"),
    );
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
    const skillMdText = "---\ndescription: d\n---\n";
    const skillMd = { path: "SKILL.md", content: skillMdText };
    for (const files of [
      [skillMd, { path: "../escape", content: "x" }],
      [skillMd, { path: "/abs", content: "x" }],
      [skillMd, { path: "link", content: "x", symlink: "/etc/passwd" }],
      [skillMd, { path: "a", content: "x" }, { path: "a", content: "y" }],
      [{ path: "SKILL.md", content: skillMdText + "x".repeat(32 * 1024) }],
      [skillMd, { path: "big", content: "x".repeat(5 * 1024 * 1024 + 1) }],
    ]) {
      const response = await publish({ files });
      expect(response.status, JSON.stringify(files).slice(0, 60)).toBe(400);
    }
    expect((await publish({})).status).toBe(400);
    expect((await publish({ description: "d", files: [skillMd] })).status).toBe(400);
    expect(db.skills.size).toBe(0);
    expect(db.skillFiles).toHaveLength(0);
  });

  it("derives name and description from the SKILL.md frontmatter and answers 400 for what it cannot", async () => {
    const { base, db } = await start();
    const publish = (path: string, content: string) =>
      call(base, "alice", "POST", `/admin/skills/${path}/versions`, {
        files: [{ path: "SKILL.md", content }],
      });
    const ok = await publish("pdf", skillMd("From the file", "name: pdf\n"));
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({
      name: "pdf",
      description: "From the file",
      disableModelInvocation: false,
    });
    const hidden = await publish("quiet", skillMd("Quiet", "disable-model-invocation: true\n"));
    expect(await json(hidden)).toMatchObject({ name: "quiet", disableModelInvocation: true });
    for (const [path, content] of [
      ["other", skillMd("d", "name: pdf\n")],
      ["nodesc", "---\nname: nodesc\n---\n"],
      ["nofm", "# just a body\n"],
      ["bad", "---\ndescription: |\n  block\n---\n"],
    ] as const) {
      const response = await publish(path, content);
      expect(response.status, path).toBe(400);
    }
    expect([...db.skills.keys()].sort()).toEqual(["pdf", "quiet"]);
  });

  it("deletes a whole skill with its version as the revision, but never one version or its update", async () => {
    const { base } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    expect((await call(base, "alice", "PUT", "/admin/skills/pdf/versions/1", PDF)).status).toBe(
      405,
    );
    expect((await call(base, "alice", "DELETE", "/admin/skills/pdf/versions/1")).status).toBe(405);
    expect((await call(base, "alice", "GET", "/admin/skills/pdf/files")).status).toBe(404);
    expect((await call(base, "alice", "DELETE", "/admin/skills/pdf")).status).toBe(400);
    expect(
      (await call(base, "alice", "DELETE", "/admin/skills/pdf?expectedRevision=2")).status,
    ).toBe(409);
    const gone = await call(base, "alice", "DELETE", "/admin/skills/pdf?expectedRevision=1");
    expect(await gone.json()).toEqual({ name: "pdf", deleted: true, lastVersion: 1 });
    expect((await call(base, "alice", "GET", "/admin/skills/pdf")).status).toBe(404);
    expect((await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF)).status).toBe(409);
  });
});

describe("profiles with skills and sessions", () => {
  it("a skill a profile pins or a live session uses is not deleted; the 409 names them", async () => {
    const { base, db } = await start();
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", PDF);
    await call(base, "alice", "PUT", "/admin/profiles/docs", {
      definition: { skills: [{ name: "pdf", version: 1 }] },
    });
    const created = await json(await call(base, "bob", "POST", "/sessions", { profile: "docs" }));
    const pinned = await call(base, "alice", "DELETE", "/admin/skills/pdf?expectedRevision=1");
    expect(pinned.status).toBe(409);
    expect(await json(pinned)).toMatchObject({
      blockedBy: {
        profiles: [{ name: "docs", version: 1 }],
        sessions: { count: 1, sample: [created.sessionId] },
      },
    });
    expect(db.skills.size).toBe(1);
  });

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
    await call(base, "alice", "POST", "/admin/skills/pdf/versions", withDescription("new"));
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

  it("GET /sessions/{id} shows the usage the orchestrator recorded, and no usage before the first run settled (#185)", async () => {
    const { base, db } = await start();
    const created = await json(await call(base, "bob", "POST", "/sessions", {}));
    const id = String(created.sessionId);
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).usage).toBeUndefined();
    const usage = {
      totalTokens: 1_234,
      input: 1_000,
      output: 234,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.0042,
      updatedAt: "2026-11-18T09:00:00.000Z",
    };
    const row = db.sessions.get(id);
    if (row === undefined) throw new Error("no session row");
    Object.assign(row, { usage });
    expect((await json(await call(base, "bob", "GET", `/sessions/${id}`))).usage).toEqual(usage);
  });

  it("GET /sessions/{id} shows repoSkills only when the snapshot turned it on and the session has a repo", async () => {
    const { base } = await start();
    const put = await call(base, "alice", "PUT", "/admin/profiles/repo-docs", {
      definition: { repoSkills: true, repoContext: true },
    });
    expect(put.status).toBe(201);
    const withRepo = await json(
      await call(base, "bob", "POST", "/sessions", { profile: "repo-docs", repo: "acme/widgets" }),
    );
    const got = await json(
      await call(base, "bob", "GET", `/sessions/${String(withRepo.sessionId)}`),
    );
    expect(got.repoSkills).toBe(true);
    expect(got.repoContext).toBe(true);
    const noRepo = await json(
      await call(base, "bob", "POST", "/sessions", { profile: "repo-docs" }),
    );
    const gotPlain = await json(
      await call(base, "bob", "GET", `/sessions/${String(noRepo.sessionId)}`),
    );
    expect(gotPlain.repoSkills).toBeUndefined();
    expect(gotPlain.repoContext).toBeUndefined();
    const noRead = await call(base, "alice", "PUT", "/admin/profiles/bad", {
      definition: { tools: ["bash"], repoSkills: true },
    });
    expect(noRead.status).toBe(400);
    expect((await json(noRead)).error).toContain("repoSkills needs the read tool");
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
