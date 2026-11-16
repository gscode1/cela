import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelPolicy } from "@pi-durable-k8s/session-core";
import { createIngestServer } from "../src/server.ts";
import { FakeInboxDb, SESSION } from "./fake-db.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

async function start(db: FakeInboxDb): Promise<string> {
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: () => Promise.resolve({ owner: "alice", subject: "static:alice" }),
    orchestratorUrl: "http://unused",
    models: {} as ModelPolicy,
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/sessions/${SESSION}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("DELETE and client event ids", () => {
  it("queues the delete row even if the client used the id 'delete:<session>' for a message", async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    const sent = await post(base, {
      kind: "message",
      text: "x",
      sourceEventId: `delete:${SESSION}`,
    });
    expect(sent.status).toBe(202);

    const res = await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" });
    expect(res.status).toBe(202);
    expect(db.events.map((e) => e.kind).sort()).toEqual(["delete", "message"]);
    expect(db.status).toBe("deleting");
  });

  it("repeating DELETE does not add a second delete row", async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" });
    await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" });
    expect(db.events.filter((e) => e.kind === "delete")).toHaveLength(1);
  });

  it("a repeated DELETE puts a failed delete row back to pending", async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" });
    const row = db.events.find((e) => e.kind === "delete");
    if (row === undefined) throw new Error("no delete row");
    row.status = "failed";
    await fetch(`${base}/sessions/${SESSION}`, { method: "DELETE" });
    expect(row.status).toBe("pending");
    expect(db.events.filter((e) => e.kind === "delete")).toHaveLength(1);
  });
}, 10_000);
