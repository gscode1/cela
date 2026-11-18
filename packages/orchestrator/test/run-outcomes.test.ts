import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent, SessionRow } from "@pi-durable-k8s/session-core";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { SessionService } from "../src/sessions.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});
const MODEL = { provider: "scripted", model: "scripted-1" } as const;

const hosts: Host[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  vi.restoreAllMocks();
});

/** A host whose only tool, `hold`, waits until `release()`. */
async function holdingHost() {
  const gate = Promise.withResolvers<undefined>();
  const hold = defineTool<object>({
    name: "hold",
    description: "waits to be released",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await gate.promise;
      return { output: [{ type: "text", text: "ok" }] };
    },
  });
  const host = await Host.open(
    new MemoryStorage(),
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
    {},
    [],
    { codingExtension: defineExtension({ name: "coding", tools: [hold] }) },
  );
  hosts.push(host);
  return { host, release: () => gate.resolve(undefined) };
}

describe("Host.settlement (Submission.wait)", () => {
  it("resolves when the input settles, and undefined for an input Pi Durable never admitted", async () => {
    const { host, release } = await holdingHost();
    const id = await host.createConversation(MODEL);
    expect(await host.settlement(id, "nope")).toBeUndefined();
    await host.submitInput(id, {
      text: JSON.stringify({ steps: [{ tool: "hold", args: {} }], final: "ok" }),
      requestId: "r1",
      steer: false,
    });
    const settled = host.settlement(id, "r1");
    release();
    expect(await settled).toEqual({ status: "done" });
  }, 10_000);

  it("withdraws the inputs queued behind a failed run instead of leaving them queued (afterFailedRun)", async () => {
    const { host, release } = await holdingHost();
    const id = await host.createConversation(MODEL);
    const failing = {
      steps: [{ tool: "hold", args: {} }],
      error: "400 Bad Request: context too long",
    };
    await host.submitInput(id, { text: JSON.stringify(failing), requestId: "r1", steer: false });
    for (let i = 0; i < 200 && (await host.runTurns(id)) < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Queued behind the running run, which then fails.
    await host.submitInput(id, { text: "after", requestId: "r2", steer: false });
    expect(await host.submissionState(id, "r2")).toEqual(
      expect.objectContaining({ status: "queued" }),
    );
    release();
    expect(await host.settlement(id, "r1")).toMatchObject({
      status: "unanswered",
      reason: "model_error",
    });
    expect(await host.settlement(id, "r2")).toMatchObject({
      status: "unanswered",
      reason: "run_failed",
    });
  }, 10_000);
});

describe("SessionService after a run answered", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const row = (status: string) => ({
    id: SESSION,
    owner: "alice",
    owner_subject: "static:alice",
    status,
    conversation_id: "7",
    model_provider: null,
    model_id: null,
    model_reasoning: null,
    failure: null,
    repo: null,
    repo_branch: null,
    onecli_agent_id: null,
    onecli_secret_ids: null,
    workspace_ready_at: null,
    profile_name: null,
    profile_version: null,
    profile_snapshot: null,
    shard: 0,
    created_at: new Date(),
    last_activity_at: new Date(),
  });
  const session: SessionRow = {
    id: SESSION,
    owner: "alice",
    ownerSubject: "static:alice",
    status: "active",
    shard: 0,
    conversationId: 7,
    model: null,
    failure: null,
    repo: null,
    onecli: null,
    workspaceReadyAt: null,
    profile: null,
    usage: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };
  const message: InboxEvent = {
    id: "1",
    sessionId: SESSION,
    source: "api:alice",
    sourceEventId: "m1",
    kind: "message",
    payload: { text: "hi" },
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
    submittedAt: null,
    error: null,
  };

  function setup(status: string) {
    const limits: number[] = [];
    // Admission: 2 turns used, idle. Once the run answered: 5 used, 2 of them by the queued run already going.
    const turns = [2, 5];
    const running = [0, 2];
    const pool = {
      query: (sql: string) =>
        Promise.resolve(
          sql.includes("select * from inbox.sessions")
            ? { rows: [row(status)], rowCount: 1 }
            : { rows: [], rowCount: 0 },
        ),
    } as unknown as pg.Pool;
    const host = {
      applyProfileTools: () => Promise.resolve(),
      runTurns: () => Promise.resolve(running.shift() ?? 0),
      turnsUsed: () => Promise.resolve(turns.shift() ?? 0),
      limitTurns: (_id: number, limit: number) => {
        limits.push(limit);
        return Promise.resolve();
      },
      submitInput: () => Promise.resolve(),
      settlement: () => Promise.resolve({ status: "done" }),
    } as unknown as Host;
    const service = new SessionService(pool, host, {
      shard: 0,
      testFaults: false,
      defaultModel: { provider: "p", model: "m" },
      turnBudget: () => 10,
    });
    return { service, limits };
  }

  it("sets maxTurns again, so a run queued behind it gets what is left of the budget", async () => {
    const { service, limits } = setup("active");
    await service.apply(message, session);
    for (let i = 0; i < 100 && limits.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 10 − 2 at admission; then 10 − (5 − 2): the turns before the queued run, not its own.
    expect(limits).toEqual([8, 7]);
    service.stop();
  });

  it("leaves a session alone that is no longer active", async () => {
    const { service, limits } = setup("failed");
    await service.apply(message, session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limits).toEqual([8]);
    service.stop();
  });
});

describe("usage on the session row (#185)", () => {
  it("copies the conversation's pi.usage totals to the session when its input settles", async () => {
    const { host, release } = await holdingHost();
    release();
    const conversationId = await host.createConversation(MODEL);
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as pg.Pool;
    const service = new SessionService(pool, host, {
      shard: 0,
      testFaults: false,
      defaultModel: MODEL,
      turnBudget: () => 10,
    });
    const session: SessionRow = {
      id: "usage-session",
      owner: "alice",
      ownerSubject: "static:alice",
      status: "active",
      shard: 0,
      conversationId,
      model: null,
      failure: null,
      repo: null,
      onecli: null,
      workspaceReadyAt: null,
      profile: null,
      usage: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
    await service.apply(
      {
        id: "1",
        sessionId: session.id,
        source: "api:alice",
        sourceEventId: "m1",
        kind: "message",
        payload: { text: "hi" },
        status: "pending",
        attempts: 0,
        createdAt: new Date(),
        submittedAt: null,
        error: null,
      },
      session,
    );
    const written = () => queries.find((q) => q.sql.includes("set usage"));
    for (let i = 0; i < 200 && written() === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const write = written();
    expect(write?.params[0]).toBe("usage-session");
    const usage = JSON.parse(String(write?.params[1])) as Awaited<ReturnType<Host["usage"]>>;
    const total = await host.tokensUsed(conversationId);
    expect(total).toBeGreaterThan(0);
    expect(usage).toEqual(await host.usage(conversationId));
    expect(usage.totalTokens).toBe(total);
    expect(usage.input + usage.output).toBeGreaterThan(0);
    // The guard against an older read overwriting a newer one compares with the same total.
    expect(write?.params[2]).toBe(total);
    service.stop();
  }, 15_000);
});
