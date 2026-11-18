import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { crc32 } from "node:zlib";
import { SettingsCache, seedSettings } from "@pi-durable-k8s/session-core";
import type { Settings } from "@pi-durable-k8s/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

const seed: Settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  tokenBudget: null,
};

let server: Server | undefined;
let cache: SettingsCache | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  server?.close();
  await cache?.stop();
});

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

const call = (base: string, method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer alice",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const SERVER = { url: "https://mcp.example.com/mcp", readOnly: true };
const SOURCE = { repository: "github.com/acme/catalog", commit: "0123abc" };
const md = `---\ndescription: "Summarise a PDF"\n---\n# PDF\n`;
const PDF = {
  files: [
    { path: "SKILL.md", content: md },
    { path: "scripts/run.sh", content: "echo hi\n", executable: true },
    { path: "data/blob.bin", contentBase64: Buffer.from([0, 255, 7]).toString("base64") },
  ],
};

describe("settings revision and the default-profile guard", () => {
  it("returns the revision, refuses a stale expectedRevision with 409 and keeps unknown keys at 400", async () => {
    const { base, db } = await start();
    const got = await json(await call(base, "GET", "/admin/settings"));
    expect(got.revision).toBe(1);
    const put = await call(base, "PUT", "/admin/settings", { turnBudget: 5, expectedRevision: 1 });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({ turnBudget: 5, revision: 2 });
    const stale = await call(base, "PUT", "/admin/settings", {
      turnBudget: 6,
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error as string).toMatch(/revision 2/);
    expect(db.row?.turn_budget).toBe(5);
    // Omitted: as before.
    expect((await call(base, "PUT", "/admin/settings", { turnBudget: 7 })).status).toBe(200);
    for (const bad of [0, "1", 1.5, null]) {
      const response = await call(base, "PUT", "/admin/settings", { expectedRevision: bad });
      expect(response.status, String(bad)).toBe(400);
    }
    expect((await call(base, "PUT", "/admin/settings", { extra: 1 })).status).toBe(400);
    expect(db.row?.turn_budget).toBe(7);
  });

  it("answers 409 for disabling the default profile and 400 for selecting a disabled or missing one", async () => {
    const { base, db } = await start();
    const off = await call(base, "PUT", "/admin/profiles/coding", { enabledForNew: false });
    expect(off.status).toBe(409);
    expect((await json(off)).error as string).toMatch(/select another/);
    expect(db.profiles.get("coding")?.enabled_for_new).toBe(true);
    await call(base, "PUT", "/admin/profiles/research", { definition: {} });
    await call(base, "PUT", "/admin/profiles/research", { enabledForNew: false });
    const select = (name: string) => call(base, "PUT", "/admin/settings", { defaultProfile: name });
    expect((await select("research")).status).toBe(400);
    expect((await select("ghost")).status).toBe(400);
    await call(base, "PUT", "/admin/profiles/research", { enabledForNew: true });
    expect((await select("research")).status).toBe(200);
    expect(
      (await call(base, "PUT", "/admin/profiles/research", { enabledForNew: false })).status,
    ).toBe(409);
    expect(
      (await call(base, "PUT", "/admin/profiles/coding", { enabledForNew: false })).status,
    ).toBe(200);
  });
});

describe("profile revision", () => {
  it("bumps on a new version and on enable and disable; a stale write is 409 and changes nothing", async () => {
    const { base, db } = await start();
    const created = await json(
      await call(base, "PUT", "/admin/profiles/research", { definition: {} }),
    );
    expect(created.revision).toBe(1);
    const off = await json(
      await call(base, "PUT", "/admin/profiles/research", {
        enabledForNew: false,
        expectedRevision: 1,
      }),
    );
    expect(off).toMatchObject({ revision: 2, currentVersion: 1, enabledForNew: false });
    const on = await json(
      await call(base, "PUT", "/admin/profiles/research", { enabledForNew: true }),
    );
    expect(on.revision).toBe(3);
    for (const body of [
      { definition: { turnBudget: 4 }, expectedRevision: 2 },
      { enabledForNew: false, expectedRevision: 2 },
    ]) {
      expect((await call(base, "PUT", "/admin/profiles/research", body)).status).toBe(409);
    }
    const got = await json(await call(base, "GET", "/admin/profiles/research"));
    expect(got).toMatchObject({ revision: 3, currentVersion: 1, enabledForNew: true });
    expect(db.versions.filter((v) => v.name === "research")).toHaveLength(1);
    const list = (await json(await call(base, "GET", "/admin/profiles"))) as {
      profiles: { name: string; revision: number }[];
    };
    expect(list.profiles.map((p) => [p.name, p.revision])).toEqual([
      ["coding", 1],
      ["research", 3],
    ]);
    const bad = await call(base, "PUT", "/admin/profiles/research", { expectedRevision: "x" });
    expect(bad.status).toBe(400);
    expect(
      (await call(base, "PUT", "/admin/profiles/research", { expectedRevision: 3, extra: 1 }))
        .status,
    ).toBe(400);
  });

  it("expectedRevision 0 creates only: 201 for a new name, 409 and no new version for an existing one", async () => {
    const { base, db } = await start();
    const created = await call(base, "PUT", "/admin/profiles/research", {
      definition: {},
      expectedRevision: 0,
    });
    expect(created.status).toBe(201);
    const again = await call(base, "PUT", "/admin/profiles/research", {
      definition: { turnBudget: 4 },
      expectedRevision: 0,
    });
    expect(again.status).toBe(409);
    expect((await json(again)).error as string).toMatch(/already exists/);
    expect(db.versions.filter((v) => v.name === "research")).toHaveLength(1);
    expect(
      (
        await call(base, "PUT", "/admin/profiles/research", {
          definition: {},
          expectedRevision: -1,
        })
      ).status,
    ).toBe(400);
  });
});

describe("MCP server revision and source", () => {
  it("returns revision and source; a stale PUT or DELETE is 409 and nothing changes", async () => {
    const { base, db } = await start();
    const created = await call(base, "PUT", "/admin/mcp-servers/demo", {
      ...SERVER,
      source: SOURCE,
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ revision: 1, source: SOURCE });
    const off = await call(base, "PUT", "/admin/mcp-servers/demo", {
      enabled: false,
      expectedRevision: 1,
    });
    expect(await json(off)).toMatchObject({ revision: 2, enabled: false, source: SOURCE });
    expect(
      (await call(base, "PUT", "/admin/mcp-servers/demo", { enabled: true, expectedRevision: 1 }))
        .status,
    ).toBe(409);
    expect((await call(base, "DELETE", "/admin/mcp-servers/demo?expectedRevision=1")).status).toBe(
      409,
    );
    expect((await call(base, "DELETE", "/admin/mcp-servers/demo?expectedRevision=x")).status).toBe(
      400,
    );
    expect(db.mcp.get("demo")).toMatchObject({ enabled: false, revision: 2 });
    const bad = await call(base, "PUT", "/admin/mcp-servers/demo", { source: { repository: "r" } });
    expect(bad.status).toBe(400);
    expect(
      (await call(base, "PUT", "/admin/mcp-servers/demo", { extra: 1, expectedRevision: 2 }))
        .status,
    ).toBe(400);
    const got = await json(await call(base, "GET", "/admin/mcp-servers/demo"));
    expect(got).toMatchObject({ revision: 2, source: SOURCE });
    const del = await call(base, "DELETE", "/admin/mcp-servers/demo?expectedRevision=2");
    expect(del.status).toBe(200);
    expect(db.mcp.size).toBe(0);
  });

  it("expectedRevision 0 creates only: 409 for an existing server, which is left as it was", async () => {
    const { base, db } = await start();
    const created = await call(base, "PUT", "/admin/mcp-servers/demo", {
      ...SERVER,
      expectedRevision: 0,
    });
    expect(created.status).toBe(201);
    await call(base, "PUT", "/admin/mcp-servers/demo", { enabled: false });
    const again = await call(base, "PUT", "/admin/mcp-servers/demo", {
      ...SERVER,
      enabled: true,
      expectedRevision: 0,
    });
    expect(again.status).toBe(409);
    expect((await json(again)).error as string).toMatch(/already exists/);
    expect(db.mcp.get("demo")).toMatchObject({ enabled: false, revision: 2 });
    // A DELETE always names the revision it saw: 0 is not one.
    expect((await call(base, "DELETE", "/admin/mcp-servers/demo?expectedRevision=0")).status).toBe(
      400,
    );
  });
});

describe("GET /admin/tools", () => {
  it("lists the built-in names until the orchestrator publishes, then its tools", async () => {
    const { base, db } = await start();
    expect(await json(await call(base, "GET", "/admin/tools"))).toEqual({
      tools: ["read", "write", "edit", "bash"],
      source: "builtin",
    });
    db.capabilities = { tools: ["read", "grep"], extensions: ["coding-tools"], instance: "o" };
    expect(await json(await call(base, "GET", "/admin/tools"))).toEqual({
      tools: ["read", "grep"],
      source: "orchestrator",
    });
    expect((await call(base, "POST", "/admin/tools", {})).status).toBe(405);
  });
});

/** Stored entries of a zip: path, bytes and Unix mode, with the CRC-32 checked. */
function unzip(zip: Buffer): { path: string; content: Buffer; mode: number }[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  let at = zip.readUInt32LE(end + 16);
  const out: { path: string; content: Buffer; mode: number }[] = [];
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const content = zip.subarray(start, start + size);
    expect(crc32(content)).toBe(zip.readUInt32LE(at + 16));
    out.push({
      path: zip.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      content,
      mode: zip.readUInt32LE(at + 38) >>> 16,
    });
    at += 46 + nameLength;
  }
  return out;
}

describe("skill source and zip download", () => {
  it("stores source, keeps it out of the digest, and ignores a new source on identical files", async () => {
    const { base } = await start();
    const first = await call(base, "POST", "/admin/skills/pdf/versions", {
      ...PDF,
      source: SOURCE,
    });
    expect(first.status).toBe(201);
    const v1 = await json(first);
    expect(v1.source).toEqual(SOURCE);
    const again = await call(base, "POST", "/admin/skills/pdf/versions", {
      ...PDF,
      source: { ...SOURCE, commit: "fedcba9" },
    });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({
      version: 1,
      versionCreated: false,
      digest: v1.digest,
      source: SOURCE,
    });
    const none = await call(base, "POST", "/admin/skills/plain/versions", PDF);
    expect((await json(none)).source).toBeNull();
    const bad = await call(base, "POST", "/admin/skills/pdf/versions", {
      ...PDF,
      source: { repository: "r", commit: "nothex" },
    });
    expect(bad.status).toBe(400);
  });

  it("downloads a version as a zip with its paths, bytes and executable bit", async () => {
    const { base } = await start();
    await call(base, "POST", "/admin/skills/pdf/versions", PDF);
    const response = await call(base, "GET", "/admin/skills/pdf/versions/1/zip");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="pdf-v1.zip"');
    const files = unzip(Buffer.from(await response.arrayBuffer()));
    expect(files.map((f) => [f.path, f.mode.toString(8)])).toEqual([
      ["SKILL.md", "100644"],
      ["data/blob.bin", "100644"],
      ["scripts/run.sh", "100755"],
    ]);
    expect(files.find((f) => f.path === "scripts/run.sh")?.content.toString()).toBe("echo hi\n");
    expect(files.find((f) => f.path === "data/blob.bin")?.content).toEqual(
      Buffer.from([0, 255, 7]),
    );
    expect((await call(base, "GET", "/admin/skills/pdf/versions/2/zip")).status).toBe(404);
    expect((await call(base, "GET", "/admin/skills/pdf/versions/x/zip")).status).toBe(400);
    expect((await call(base, "POST", "/admin/skills/pdf/versions/1/zip", {})).status).toBe(405);
    expect((await call(base, "GET", "/admin/skills/pdf/versions/1/other")).status).toBe(404);
  });
});
