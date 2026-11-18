import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { InboxEvent, SessionRow } from "@pi-durable-k8s/session-core";
import type { Host } from "../src/host.ts";
import { PermanentError, SessionService } from "../src/sessions.ts";

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
  createdAt: new Date(),
  lastActivityAt: new Date(),
});

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

/** `dbStatus` is what inbox.sessions says; `failRows` is how many rows the `where status = 'active'` update changes. */
function setup(options: { dbStatus: string; failRows: number; abortFailures?: number }) {
  const aborts: number[] = [];
  let abortFailures = options.abortFailures ?? 0;
  const failedConversations = [7, 9];
  const pool = {
    query: (sql: string) => {
      if (sql.includes("set status = 'failed'")) {
        return Promise.resolve({ rows: [], rowCount: options.failRows });
      }
      if (sql.includes("select * from inbox.sessions")) {
        return Promise.resolve({ rows: [{ ...rowOf(options.dbStatus) }] });
      }
      if (sql.includes("where status = 'failed'")) {
        return Promise.resolve({
          rows: failedConversations.map((c) => ({ id: SESSION, conversation_id: String(c) })),
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as pg.Pool;
  const host = {
    // Over the budget of 5 turns, so an input to an active session fails it.
    applyProfileTools: () => Promise.resolve(),
    runTurns: () => Promise.resolve(0),
    turnsUsed: () => Promise.resolve(10),
    abort: (id: number) => {
      aborts.push(id);
      if (abortFailures > 0) {
        abortFailures -= 1;
        return Promise.reject(new Error("storage hiccup"));
      }
      return Promise.resolve();
    },
  } as unknown as Host;
  const service = new SessionService(pool, host, {
    shard: 0,
    testFaults: false,
    defaultModel: { provider: "p", model: "m" },
    turnBudget: () => 5,
  });
  return { service, aborts };
}

function rowOf(status: string) {
  return {
    id: SESSION,
    owner: "alice",
    owner_subject: "static:alice",
    status,
    conversation_id: "7",
    model_provider: null,
    model_id: null,
    model_reasoning: null,
    failure: "x",
    repo: null,
    repo_branch: null,
    onecli_agent_id: null,
    onecli_secret_ids: null,
    workspace_ready_at: null,
    created_at: new Date(),
    last_activity_at: new Date(),
  };
}

describe("aborting the conversation of a failed session", () => {
  it("is retried when the first abort died after the status was committed", async () => {
    const { service, aborts } = setup({ dbStatus: "failed", failRows: 1, abortFailures: 1 });
    // First try: the status update commits, the abort throws; the row is retried.
    await expect(service.apply(message, session("active"))).rejects.toThrow("storage hiccup");
    // The retry reads the session as failed: it must abort again, then end the row for good.
    await expect(service.apply(message, session("failed"))).rejects.toBeInstanceOf(PermanentError);
    expect(aborts).toEqual([7, 7]);
  });

  it("aborts even though the failure update changed no row, if the session is already failed", async () => {
    const { service, aborts } = setup({ dbStatus: "failed", failRows: 0 });
    await expect(service.apply(message, session("active"))).rejects.toBeInstanceOf(PermanentError);
    expect(aborts).toEqual([7]);
  });

  it("does not abort a session that is deleting or deleted", async () => {
    const { service, aborts } = setup({ dbStatus: "deleting", failRows: 0 });
    await expect(service.apply(message, session("active"))).rejects.toBeInstanceOf(PermanentError);
    expect(aborts).toEqual([]);
  });

  it("is repeated for recently failed sessions at start, and one failure does not stop the rest", async () => {
    const { service, aborts } = setup({ dbStatus: "failed", failRows: 0, abortFailures: 1 });
    await service.recoverWatches();
    expect(aborts).toEqual([7, 9]);
  });
}, 10_000);
