import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";
import { FakeInboxDb, SESSION } from "./fake-db.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("ingest stream proxy", () => {
  it("forwards the status and Retry-After of an orchestrator that is not ready", async () => {
    const seen: IncomingMessage[] = [];
    const upstream = await listen(
      createServer((req, res) => {
        seen.push(req);
        res.writeHead(503, { "content-type": "application/json", "retry-after": "7" });
        res.end('{"error":"waiting-for-lock"}');
      }),
    );
    const db = new FakeInboxDb();
    db.shard = 1;
    const base = await listen(
      createIngestServer({
        pool: db.asPool(),
        authenticate: () => Promise.resolve({ owner: "alice", subject: "static:alice" }),
        orchestratorUrl: upstream,
        shards: 2,
        settings: {} as SettingsView,
        admins: [],
        schemaReady: () => true,
      }),
    );
    const response = await fetch(`${base}/sessions/${SESSION}/stream`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(seen[0]?.url).toBe(`/sessions/${SESSION}/stream`);
  }, 10_000);
});
