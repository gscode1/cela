import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createOrchestratorServer } from "../src/http.ts";
import type { Host } from "../src/host.ts";
import type { SessionService } from "../src/sessions.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("orchestrator /healthz", () => {
  it("answers 200 while waiting for the lock, without touching the database or authenticating", async () => {
    const pool = new Proxy(
      {},
      { get: () => () => Promise.reject(new Error("database touched")) },
    ) as pg.Pool;
    server = createOrchestratorServer({
      lifecycle: { state: "waiting-for-lock", instance: "t" },
      authenticate: () => Promise.reject(new Error("authenticate called")),
      pool,
      shard: 0,
      control: false,
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", state: "waiting-for-lock" });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
  }, 10_000);
});

describe("orchestrator stream of a session of another shard", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";

  it("answers 421 and never creates a conversation", async () => {
    let ensured = 0;
    const row = {
      id: SESSION,
      owner: "alice",
      owner_subject: "static:alice",
      status: "active",
      shard: 1,
      conversation_id: null,
      created_at: new Date(),
      last_activity_at: new Date(),
    };
    const pool = { query: () => Promise.resolve({ rows: [row] }) } as unknown as pg.Pool;
    server = createOrchestratorServer({
      lifecycle: {
        state: "owner",
        instance: "t",
        host: {} as Host,
        service: {
          ensureConversation: () => {
            ensured += 1;
            return Promise.resolve(2);
          },
        } as unknown as SessionService,
      },
      authenticate: () => Promise.resolve({ owner: "alice", subject: "static:alice" }),
      pool,
      shard: 0,
      control: false,
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const response = await fetch(`${base}/sessions/${SESSION}/stream`);
    expect(response.status).toBe(421);
    expect(ensured).toBe(0);
  }, 10_000);
});
