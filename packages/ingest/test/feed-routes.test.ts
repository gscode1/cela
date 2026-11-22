import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { feedStreamCount } from "../src/feed-routes.ts";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** Answers readFeed's two statements from `rows`, ordered and filtered by position as Postgres would. */
class FakeFeedDb {
  rows: { id: string; xid: string; owner: string }[] = [];
  readonly calls: unknown[][] = [];
  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    if (sql.includes("from inbox.feed_horizon")) return Promise.resolve({ rows: [] });
    if (sql.includes("from inbox.feed")) {
      this.calls.push(params);
      const [owner, xid, id, limit] = params as [string, string, string, number];
      const after = (r: { xid: string; id: string }) =>
        BigInt(r.xid) > BigInt(xid) || (r.xid === xid && BigInt(r.id) > BigInt(id));
      const rows = this.rows
        .filter((r) => r.owner === owner && after(r))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          xid: r.xid,
          session_id: "11111111-2222-4333-8444-555555555555",
          type: "session.created",
          data: {},
          created_at: new Date("2026-11-22T10:00:00Z"),
        }));
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  }
}

async function start(db: FakeFeedDb): Promise<string> {
  server = createIngestServer({
    pool: db as unknown as pg.Pool,
    authenticate: () => Promise.resolve({ owner: "alice", subject: "static:alice" }),
    orchestratorUrl: "http://unused",
    settings: {} as SettingsView,
    admins: [],
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("GET /events", () => {
  it(
    "returns the caller's rows only, with the cursor of the last one",
    { timeout: 10_000 },
    async () => {
      const db = new FakeFeedDb();
      db.rows = [
        { id: "1", xid: "10", owner: "static:alice" },
        { id: "2", xid: "11", owner: "static:bob" },
        { id: "3", xid: "12", owner: "static:alice" },
      ];
      const base = await start(db);
      const page = (await (await fetch(`${base}/events?limit=1`)).json()) as Record<
        string,
        unknown
      >;
      expect(page).toMatchObject({ cursor: "10-1", hasMore: true, truncated: false });
      const next = (await (await fetch(`${base}/events?cursor=10-1`)).json()) as {
        events: { id: string; cursor: string }[];
        cursor: string;
      };
      expect(next.events.map((e) => [e.id, e.cursor])).toEqual([["3", "12-3"]]);
      expect(next.cursor).toBe("12-3");
      expect(db.calls.every((params) => params[0] === "static:alice")).toBe(true);
    },
  );

  it("refuses a cursor or limit it did not issue", { timeout: 10_000 }, async () => {
    const base = await start(new FakeFeedDb());
    for (const query of [
      "cursor=5",
      "cursor=a-b",
      "cursor=1-2-3",
      "limit=0",
      "limit=501",
      "limit=x",
    ]) {
      expect((await fetch(`${base}/events?${query}`)).status, query).toBe(400);
    }
  });
});

describe("GET /events/stream", () => {
  it(
    "sends each row with its cursor as the id, resuming after Last-Event-ID",
    { timeout: 10_000 },
    async () => {
      const db = new FakeFeedDb();
      db.rows = [
        { id: "1", xid: "10", owner: "static:alice" },
        { id: "3", xid: "12", owner: "static:alice" },
      ];
      const base = await start(db);
      const controller = new AbortController();
      const res = await fetch(`${base}/events/stream`, {
        headers: { "last-event-id": "10-1" },
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("id: 12-3\nevent: session.created\n");
      expect(text).not.toContain("10-1\nevent");
      expect(feedStreamCount()).toBe(1);
      controller.abort();
      for (let i = 0; i < 100 && feedStreamCount() > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(feedStreamCount()).toBe(0);
    },
  );

  it("refuses a Last-Event-ID it did not issue", { timeout: 10_000 }, async () => {
    const base = await start(new FakeFeedDb());
    const res = await fetch(`${base}/events/stream`, { headers: { "last-event-id": "nope" } });
    expect(res.status).toBe(400);
  });
});
