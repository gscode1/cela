import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";
import { FakeInboxDb, SESSION } from "./fake-db.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

async function start(db: FakeInboxDb, subject = "static:alice"): Promise<string> {
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: () => Promise.resolve({ owner: "alice", subject }),
    orchestratorUrl: "http://unused",
    settings: {} as SettingsView,
    admins: [],
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function send(base: string): Promise<string> {
  const res = await fetch(`${base}/sessions/${SESSION}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "message", text: "hi" }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { eventId: string }).eventId;
}

const read = (base: string, eventId: string) =>
  fetch(`${base}/sessions/${SESSION}/events/${eventId}`);

describe("GET /sessions/{id}/events/{eventId}", () => {
  it("answers a pending input with its status and no outcome", { timeout: 10_000 }, async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    const eventId = await send(base);
    const res = await read(base, eventId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      eventId,
      kind: "message",
      status: "pending",
      createdAt: "2026-11-22T10:00:00.000Z",
    });
  });

  it("returns the outcome once the orchestrator recorded it", { timeout: 10_000 }, async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    const answered = await send(base);
    const withdrawn = await send(base);
    Object.assign(db.events[0] ?? {}, {
      status: "submitted",
      outcome: "answered",
      settledAt: new Date("2026-11-22T10:01:00Z"),
    });
    Object.assign(db.events[1] ?? {}, {
      status: "submitted",
      outcome: "unanswered",
      outcomeReason: "run_failed",
      settledAt: new Date("2026-11-22T10:01:00Z"),
    });
    expect(await (await read(base, answered)).json()).toMatchObject({
      status: "submitted",
      submittedAt: "2026-11-22T10:00:01.000Z",
      outcome: { state: "answered", settledAt: "2026-11-22T10:01:00.000Z" },
    });
    expect(await (await read(base, withdrawn)).json()).toMatchObject({
      outcome: { state: "unanswered", reason: "run_failed" },
    });
  });

  it("never returns the stored error of a failed row", { timeout: 10_000 }, async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    const eventId = await send(base);
    Object.assign(db.events[0] ?? {}, { status: "failed" });
    const body = (await (await read(base, eventId)).json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });

  it("answers 404 for ids that are not an event of this session", { timeout: 10_000 }, async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    await send(base);
    for (const id of ["2", "0", "01", "abc", "1.5", "99999999999999999999"]) {
      expect((await read(base, id)).status, id).toBe(404);
    }
  });

  it("answers 404 to another owner, like an unknown session", { timeout: 10_000 }, async () => {
    const db = new FakeInboxDb();
    const base = await start(db);
    await send(base);
    server?.closeAllConnections();
    server?.close();
    const other = await start(db, "static:bob");
    expect((await read(other, "1")).status).toBe(404);
  });
});
