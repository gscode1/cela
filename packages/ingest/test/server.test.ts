import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

async function start(schemaReady: () => boolean): Promise<string> {
  const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as pg.Pool;
  server = createIngestServer({
    pool,
    authenticate: () => Promise.resolve(undefined),
    orchestratorUrl: "http://unused",
    settings: {} as SettingsView,
    admins: [],
    schemaReady,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("ingest probes while the schema migrates", () => {
  it("answers /healthz, but not /readyz or the API, until migrations succeeded", async () => {
    let ready = false;
    const base = await start(() => ready);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/sessions`, { method: "POST" })).status).toBe(503);
    ready = true;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    // Past the gate the request reaches authentication.
    expect((await fetch(`${base}/sessions`, { method: "POST" })).status).toBe(401);
  });
});
