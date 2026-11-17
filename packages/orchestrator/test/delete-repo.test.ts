import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxEvent, SessionRow } from "@pi-durable-k8s/session-core";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { OneCliAdmin } from "../src/onecli-admin.ts";
import { Redacted } from "../src/onecli.ts";
import { agentIdentifier, RepoAccess } from "../src/repo-access.ts";
import { SessionService } from "../src/sessions.ts";
import { FakeOneCli } from "./fake-onecli.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});
const SESSION = "11111111-2222-4333-8444-555555555555";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const deleteEvent: InboxEvent = {
  id: "9",
  sessionId: SESSION,
  source: "api:alice",
  sourceEventId: `delete:${SESSION}`,
  kind: "delete",
  payload: {},
  status: "pending",
  attempts: 0,
  createdAt: new Date(),
  submittedAt: null,
  error: null,
};

async function setup(repo: SessionRow["repo"]) {
  const dir = await mkdtemp(join(tmpdir(), "del-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(join(dir, "app-id"), "1");
  await writeFile(join(dir, "installation-id"), "2");
  await writeFile(join(dir, "private-key.pem"), privateKey);
  const onecli = new FakeOneCli();
  const order: string[] = [];
  const pool = {
    query: (sql: string) => {
      if (sql.includes("inbox.tombstones") && sql.includes("insert")) order.push("tombstone");
      if (sql.includes("set status = 'deleted'")) order.push("deleted");
      if (sql.includes("update inbox.tombstones")) order.push("tombstone-completed");
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as pg.Pool;
  const ghFetch = (_url: string, init: { body?: string }) => {
    const name = (JSON.parse(init.body ?? "{}") as { repositories: string[] }).repositories[0];
    const answer = {
      token: "ghs_x",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      repositories: [{ full_name: `octo/${name ?? ""}` }],
    };
    return Promise.resolve({
      status: 201,
      json: () => Promise.resolve(answer),
      text: () => Promise.resolve(""),
    });
  };
  const repos = new RepoAccess({
    pool,
    onecli: new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), (url, init) => {
      if (init.method === "DELETE" && url.includes("/v1/agents/") && !url.includes("/grants/"))
        order.push("agent-deleted");
      return onecli.fetch(url, init);
    }),
    githubAppDir: dir,
    gateway: "http://onecli.onecli:10255",
    caFile: join(dir, "ca.pem"),
    fetch: ghFetch,
  });
  const host = await Host.open(
    new MemoryStorage(),
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
  );
  const service = new SessionService(pool, host, {
    shard: 0,
    testFaults: false,
    defaultModel: config.models.default,
    turnBudget: () => 10,
    repos,
  });
  cleanups.push(async () => {
    service.stop();
    await host.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });
  const session: SessionRow = {
    id: SESSION,
    owner: "alice",
    ownerSubject: "static:alice",
    status: "deleting",
    shard: 0,
    conversationId: null,
    model: null,
    failure: null,
    repo,
    onecli: null,
    workspaceReadyAt: null,
    profile: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };
  return { onecli, order, repos, service, session };
}

describe("session deletion and OneCLI", () => {
  it("writes the tombstone first, revokes the agent, then marks the session deleted; the secrets are gone", async () => {
    const { onecli, order, repos, service, session } = await setup({ repo: "octo/hello" });
    await repos.shellEnv({ ...session, status: "active" }, 3);
    expect(onecli.agents.size).toBe(1);

    await service.apply(deleteEvent, session);

    expect(order).toEqual(["tombstone", "agent-deleted", "deleted", "tombstone-completed"]);
    expect(onecli.agents.size).toBe(0);
    expect(
      [...onecli.secrets.values()].some((s) => s.name.startsWith(agentIdentifier(SESSION))),
    ).toBe(false);
    expect(onecli.secretNamed("Codex subscription")).toBeDefined();
  });

  it("a session without a repo is deleted with no OneCLI call at all", async () => {
    const { onecli, order, service, session } = await setup(null);
    await service.apply(deleteEvent, session);
    expect(onecli.calls).toEqual([]);
    expect(order).toEqual(["tombstone", "deleted", "tombstone-completed"]);
  });

  it("a delete retried after the session was marked deleted completes the tombstone instead of failing", async () => {
    const { onecli, order, service, session } = await setup(null);
    // The previous run died between `status = 'deleted'` and completeTombstone.
    await service.apply(deleteEvent, { ...session, status: "deleted" });
    expect(order).toEqual(["tombstone-completed"]);
    expect(onecli.calls).toEqual([]);
  });
});
