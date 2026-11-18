import { MemoryStorage } from "@earendil-works/pi-durable";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillCatalog } from "@pi-durable-k8s/session-core";
import type { ProfileDefinition, SessionRow } from "@pi-durable-k8s/session-core";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { PermanentError, SessionService } from "../src/sessions.ts";
import { SkillIntegrityError } from "../src/skills.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});
const MODEL = { provider: "scripted", model: "scripted-1" } as const;
const DIGEST = "a".repeat(64);
const CATALOG = buildSkillCatalog([
  {
    name: "pdf",
    description: "Summarise a PDF",
    location: `/workspace/.skills/pdf/${DIGEST}/SKILL.md`,
  },
]);

const hosts: Host[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  vi.restoreAllMocks();
});

async function openHost(): Promise<Host> {
  const host = await Host.open(
    new MemoryStorage(),
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
  );
  hosts.push(host);
  return host;
}

describe("the skill catalog in a conversation's instructions", () => {
  it("is stored with the conversation after the profile's own instructions, and only the metadata is there", async () => {
    const host = await openHost();
    const definition: ProfileDefinition = {
      instructions: "Be brief.",
      skills: [{ name: "pdf", version: 1, digest: DIGEST }],
    };
    const id = await host.createConversation(MODEL, definition, CATALOG);
    const text = (await host.instructionsOf(id)) ?? "";
    expect(text.startsWith("Be brief.\n\nThe following skills provide")).toBe(true);
    expect(text).toContain("Summarise a PDF");
    expect(text).toContain(`/workspace/.skills/pdf/${DIGEST}/SKILL.md`);
  });

  it("is the whole instructions of a profile that has none of its own, and is absent for a profile without skills", async () => {
    const host = await openHost();
    const only = await host.createConversation(MODEL, {}, CATALOG);
    expect(await host.instructionsOf(only)).toBe(CATALOG);
    const plain = await host.createConversation(MODEL, { instructions: "Be brief." });
    expect(await host.instructionsOf(plain)).toBe("Be brief.");
    const none = await host.createConversation(MODEL, {});
    expect(await host.instructionsOf(none)).toBeUndefined();
  });

  it("two conversations of different profiles do not see each other's skills", async () => {
    const host = await openHost();
    const other = buildSkillCatalog([
      {
        name: "csv",
        description: "Edit CSV",
        location: `/workspace/.skills/csv/${"b".repeat(64)}/SKILL.md`,
      },
    ]);
    const a = await host.createConversation(MODEL, {}, CATALOG);
    const b = await host.createConversation(MODEL, {}, other);
    const c = await host.createConversation(MODEL, {});
    expect(await host.instructionsOf(a)).not.toContain("csv");
    expect(await host.instructionsOf(b)).not.toContain("pdf");
    expect(await host.instructionsOf(c)).toBeUndefined();
  });
});

describe("SessionService creates the conversation with the catalog", () => {
  const snapshot: ProfileDefinition = { skills: [{ name: "pdf", version: 1, digest: DIGEST }] };
  const row = (): SessionRow => ({
    id: "s1",
    owner: "alice",
    ownerSubject: "static:alice",
    status: "active",
    shard: 0,
    conversationId: null,
    model: MODEL,
    failure: null,
    repo: null,
    onecli: null,
    workspaceReadyAt: null,
    profile: { name: "docs", version: 1, snapshot },
    usage: null,
    sandboxSize: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  });

  function fakePool(): pg.Pool {
    const fake = new FakeSettingsDb();
    fake.sessions.set("s1", {
      id: "s1",
      owner: "alice",
      owner_subject: "static:alice",
      status: "active",
      conversation_id: null,
      model_provider: "scripted",
      model_id: "scripted-1",
      model_reasoning: null,
      failure: null,
      repo: null,
      repo_branch: null,
      onecli_agent_id: null,
      onecli_secret_ids: null,
      workspace_ready_at: null,
      profile_name: "docs",
      profile_version: 1,
      profile_snapshot: snapshot,
      created_at: new Date(),
      last_activity_at: new Date(),
    });
    const query = fake.query.bind(fake);
    fake.query = (sql, params) =>
      sql.startsWith("update inbox.sessions set conversation_id")
        ? Promise.resolve({ rows: [], rowCount: 1 })
        : query(sql, params);
    return fake.asPool();
  }

  const service = (host: Host, catalog?: { catalogFor: () => Promise<string | undefined> }) =>
    new SessionService(fakePool(), host, {
      shard: 0,
      testFaults: false,
      defaultModel: config.models.default,
      turnBudget: () => 100,
      ...(catalog === undefined
        ? {}
        : { skills: { ...catalog, entriesFor: () => Promise.resolve([]) } }),
    });

  it("passes the snapshot's catalog to the host, so the instructions pin the digest of the session's version", async () => {
    const created: [ProfileDefinition, string | undefined][] = [];
    const host = {
      createConversation: (_m: unknown, definition: ProfileDefinition, catalog?: string) => {
        created.push([definition, catalog]);
        return Promise.resolve(1);
      },
    } as unknown as Host;
    const svc = service(host, { catalogFor: () => Promise.resolve(CATALOG) });
    expect(await svc.ensureConversation(row())).toBe(1);
    expect(created).toEqual([[snapshot, CATALOG]]);
    svc.stop();
  });

  it("fails the input for good when the skill is gone or changed, and creates no conversation", async () => {
    let created = 0;
    const host = {
      createConversation: () => {
        created += 1;
        return Promise.resolve(1);
      },
    } as unknown as Host;
    const gone = service(host, {
      catalogFor: () => Promise.reject(new SkillIntegrityError("skill pdf v1 does not exist")),
    });
    await expect(gone.ensureConversation(row())).rejects.toThrow(PermanentError);
    const unconfigured = service(host);
    await expect(unconfigured.ensureConversation(row())).rejects.toThrow(
      "skills are not configured",
    );
    expect(created).toBe(0);
    gone.stop();
    unconfigured.stop();
  });

  it("a database error is not permanent: the inbox retries it", async () => {
    const host = { createConversation: () => Promise.resolve(1) } as unknown as Host;
    const svc = service(host, { catalogFor: () => Promise.reject(new Error("connection lost")) });
    const error = await svc.ensureConversation(row()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentError);
    svc.stop();
  });
});
