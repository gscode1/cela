import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createOrchestratorServer } from "../src/http.ts";

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
