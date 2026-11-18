import { defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent, SessionRow } from "@pi-durable-k8s/session-core";
import { loadConfig } from "../src/config.ts";
import { AbortWaitTimeoutError, Host } from "../src/host.ts";
import { SessionService } from "../src/sessions.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});

const hosts: Host[] = [];
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  vi.restoreAllMocks();
});

describe("Host.abort with a deadline (#180)", () => {
  it("gives up waiting on a tool that ignores its abort, with the abort still committed", async () => {
    const gate = Promise.withResolvers<undefined>();
    // Never looks at its abort signal: only the gate ends it.
    const stubborn = defineTool<object>({
      name: "stubborn",
      description: "ignores aborts",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await gate.promise;
        return { output: [{ type: "text", text: "done anyway" }] };
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
      { codingExtension: defineExtension({ name: "coding", tools: [stubborn] }) },
    );
    hosts.push(host);
    const id = await host.createConversation({ provider: "scripted", model: "scripted-1" });
    const script = { steps: [{ tool: "stubborn", args: {} }], final: "finished" };
    await host.submitInput(id, { text: JSON.stringify(script), requestId: "r1", steer: false });
    for (let i = 0; i < 200 && (await host.runTurns(id)) < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await host.submitInput(id, { text: "queued", requestId: "r2", steer: false });

    const started = Date.now();
    await expect(host.abort(id, 100)).rejects.toBeInstanceOf(AbortWaitTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Committed before the wait: the queued input is already withdrawn.
    expect(await host.submissionState(id, "r2")).toMatchObject({ status: "unanswered" });

    gate.resolve(undefined);
    expect(await host.settlement(id, "r1")).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    // Once idle, an abort without a deadline (or with one) resolves at once.
    await host.abort(id, 100);
  }, 10_000);
});

describe("SessionService when an abort does not go idle in time", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";
  const session = (status: SessionRow["status"]): SessionRow => ({
    id: SESSION,
    owner: "alice",
    ownerSubject: "static:alice",
    status,
    shard: 0,
    conversationId: 7,
    model: null,
    failure: null,
    repo: null,
    onecli: null,
    workspaceReadyAt: null,
    profile: null,
    usage: null,
    sandboxSize: null,
    networkMode: "proxied",
    createdAt: new Date(),
    lastActivityAt: new Date(),
  });
  const event = (kind: InboxEvent["kind"]): InboxEvent => ({
    id: "1",
    sessionId: SESSION,
    source: "api:alice",
    sourceEventId: "e1",
    kind,
    payload: {},
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
    submittedAt: null,
    error: null,
  });

  function setup() {
    const calls: string[] = [];
    const pool = {
      query: () => Promise.resolve({ rows: [], rowCount: 1 }),
    } as unknown as pg.Pool;
    const host = {
      abort: (id: number, waitMs?: number) => {
        calls.push(`abort ${String(waitMs)}`);
        return Promise.reject(new AbortWaitTimeoutError(id, waitMs ?? 0));
      },
      destroySandbox: () => {
        calls.push("destroy");
        return Promise.resolve();
      },
    } as unknown as Host;
    const service = new SessionService(pool, host, {
      shard: 0,
      testFaults: false,
      defaultModel: { provider: "p", model: "m" },
      turnBudget: () => 10,
      abortWaitMs: 50,
    });
    return { service, calls };
  }

  it("deletes the sandbox anyway, which ends the stuck tool", async () => {
    const { service, calls } = setup();
    await service.apply(event("delete"), session("deleting"));
    expect(calls).toEqual(["abort 50", "destroy"]);
    service.stop();
  });

  it("fails a cancel, so the inbox releases the row and retries it", async () => {
    const { service, calls } = setup();
    await expect(service.apply(event("cancel"), session("active"))).rejects.toBeInstanceOf(
      AbortWaitTimeoutError,
    );
    expect(calls).toEqual(["abort 50"]);
    service.stop();
  });
});
