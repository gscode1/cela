import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage } from "@earendil-works/pi-durable";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxEvent, SessionRow } from "@cela/session-core";
import { loadConfig } from "../src/config.ts";
import { terminalFailure } from "../src/failure.ts";
import { Host } from "../src/host.ts";
import { PermanentError, SessionService } from "../src/sessions.ts";
import type { SubmissionState } from "../src/watcher.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
  PI_SESSION_TURN_BUDGET: "2",
});

const hosts: Host[] = [];
async function openHost(storage: Storage = new MemoryStorage()): Promise<Host> {
  const host = await Host.open(
    storage,
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
  );
  hosts.push(host);
  return host;
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
});

async function settled(host: Host, id: number, requestId: string): Promise<SubmissionState> {
  for (let i = 0; i < 200; i += 1) {
    const state = await host.submissionState(id, requestId);
    if (state?.status === "done" || state?.status === "unanswered") return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("submission did not settle");
}

describe("per-conversation model (Pi Durable 1.5.2)", () => {
  it("stores the model in the conversation, so two conversations run on different models", async () => {
    const host = await openHost();
    const a = await host.createConversation({ provider: "scripted", model: "scripted-1" });
    const b = await host.createConversation({ provider: "scripted", model: "scripted-2" });
    expect(await host.modelOf(a)).toEqual({ provider: "scripted", model: "scripted-1" });
    expect(await host.modelOf(b)).toEqual({ provider: "scripted", model: "scripted-2" });
  });

  it("keeps the model across a restart: a reopened Harness runs the conversation on it unchanged", async () => {
    // Files in a temp dir, so the second Harness reads what the first one committed, as after a restart.
    const dir = await mkdtemp(join(tmpdir(), "pi-model-"));
    try {
      const first = await openHost(await openNodeJsonlStorage(dir, context));
      const id = await first.createConversation({ provider: "scripted", model: "scripted-2" });
      await first.close();
      const second = await openHost(await openNodeJsonlStorage(dir, context));
      expect(await second.modelOf(id)).toEqual({ provider: "scripted", model: "scripted-2" });
      await second.submitInput(id, { text: "after restart", requestId: "r1", steer: false });
      expect(await settled(second, id, "r1")).toMatchObject({ status: "done" });
    } finally {
      // Close every Host before deleting its storage dir: an open Harness can still write there (ENOTEMPTY).
      for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores the reasoning effort with the model, and keeps it across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-thinking-"));
    try {
      const first = await openHost(await openNodeJsonlStorage(dir, context));
      const id = await first.createConversation({
        provider: "scripted",
        model: "scripted-1",
        reasoning: "medium",
      });
      const plain = await first.createConversation({ provider: "scripted", model: "scripted-1" });
      expect(await first.thinkingOf(id)).toBe("medium");
      expect(await first.thinkingOf(plain)).toBe("off");
      await first.close();
      const second = await openHost(await openNodeJsonlStorage(dir, context));
      expect(await second.thinkingOf(id)).toBe("medium");
      await second.submitInput(id, { text: "hi", requestId: "r1", steer: false });
      expect(await settled(second, id, "r1")).toMatchObject({ status: "done" });
    } finally {
      // Close every Host before deleting its storage dir: an open Harness can still write there (ENOTEMPTY).
      for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("answers a turn on the stored model, with nothing applied per turn", async () => {
    const host = await openHost();
    const id = await host.createConversation({ provider: "scripted", model: "scripted-2" });
    await host.submitInput(id, { text: "hello", requestId: "r1", steer: false });
    expect(await settled(host, id, "r1")).toMatchObject({ status: "done" });
    expect(await host.turnsUsed(id)).toBe(1);
  });
});

describe("a provider error", () => {
  it("reaches the submission as unanswered with the error text, which maps to a terminal failure", async () => {
    const host = await openHost();
    const id = await host.createConversation({ provider: "scripted", model: "scripted-1" });
    const script = JSON.stringify({ steps: [], error: "401 Unauthorized: no credentials" });
    await host.submitInput(id, { text: script, requestId: "r1", steer: false });
    const state = await settled(host, id, "r1");
    expect(state).toMatchObject({ status: "unanswered", reason: "model_error" });
    const detail = state.status === "unanswered" ? String(state.detail) : "";
    expect(detail).toContain("401");
    expect(terminalFailure({ reason: "model_error", detail })).toMatch(/credentials were rejected/);
  });

  it("does not make an unrelated error terminal", async () => {
    const host = await openHost();
    const id = await host.createConversation({ provider: "scripted", model: "scripted-1" });
    const script = JSON.stringify({ steps: [], error: "400 Bad Request: context too long" });
    await host.submitInput(id, { text: script, requestId: "r1", steer: false });
    const state = await settled(host, id, "r1");
    const detail = state.status === "unanswered" ? String(state.detail) : "";
    expect(terminalFailure({ reason: "model_error", detail })).toBeUndefined();
  });
});

describe("turn budget", () => {
  const session = (status: SessionRow["status"] = "active"): SessionRow => ({
    id: "s1",
    owner: "alice",
    ownerSubject: "static:alice",
    status,
    shard: 0,
    conversationId: null,
    model: { provider: "scripted", model: "scripted-1" },
    failure: null,
    repo: null,
    onecli: null,
    workspaceReadyAt: null,
    profile: null,
    usage: null,
    sandboxSize: null,
    networkMode: "proxied",
    sandboxFlavour: "default",
    createdAt: new Date(),
    lastActivityAt: new Date(),
  });
  const message = (text: string, id: string): InboxEvent => ({
    id,
    sessionId: "s1",
    source: "api:alice",
    sourceEventId: id,
    kind: "message",
    payload: { text },
    status: "pending",
    attempts: 0,
    createdAt: new Date(),
    submittedAt: null,
    error: null,
  });

  it("fails the session for good once its turns are used up, and refuses further input", async () => {
    const host = await openHost();
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as pg.Pool;
    const service = new SessionService(pool, host, {
      shard: 0,
      testFaults: false,
      defaultModel: config.models.default,
      turnBudget: () => config.turnBudget,
    });
    const conversationId = await host.createConversation(config.models.default);
    const active = { ...session(), conversationId };

    // Two turns fit the budget of 2.
    await service.apply(message("one", "1"), active);
    expect(await settled(host, conversationId, "1")).toMatchObject({ status: "done" });
    await service.apply(message("two", "2"), active);
    expect(await settled(host, conversationId, "2")).toMatchObject({ status: "done" });
    expect(queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(false);

    // The third is refused and the session is marked failed with a clear message.
    await expect(service.apply(message("three", "3"), active)).rejects.toBeInstanceOf(
      PermanentError,
    );
    const failed = queries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failed?.params[0]).toBe("s1");
    expect(String(failed?.params[1])).toMatch(/turn budget exhausted/);
    expect(await host.submissionState(conversationId, "3")).toBeUndefined();

    // Once failed, input is refused before it reaches the model.
    await expect(
      service.apply(message("four", "4"), { ...active, status: "failed" }),
    ).rejects.toThrow(/session has failed/);
    expect(await host.submissionState(conversationId, "4")).toBeUndefined();
    service.stop();
  });
});
