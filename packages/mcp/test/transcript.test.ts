import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { SessionApi } from "../src/api.js";
import { createServer } from "../src/server.js";
import type { TranscriptOptions } from "../src/transcript.js";
import { FakeApi, type EntryMessage } from "./fake-api.js";

const TIMEOUT = 15_000;
const LIVE_IDLE = { running: false, queued: 0 };

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text?: string }[];
};

interface Entry {
  id: number;
  kind: string;
  messages: {
    role: string;
    text: string;
    truncated?: boolean;
    length?: number;
    calls?: { name: string; arguments: string; truncated?: boolean; length?: number }[];
    isError?: boolean;
    usage?: Record<string, number>;
  }[];
  omitted?: boolean;
  length?: number;
}

interface Page {
  sessionId: string;
  entries: Entry[];
  cursor?: number;
  hasMore: boolean;
}

let fake: FakeApi;
let client: Client;
let cleanup: (() => Promise<void>)[] = [];

async function setup(transcript?: TranscriptOptions, token?: string): Promise<void> {
  fake = await FakeApi.start();
  const t = token ?? fake.token;
  const server = createServer(
    { apiUrl: fake.url, token: t, maxSessions: 20 },
    new SessionApi({ apiUrl: fake.url, token: t }),
    transcript === undefined ? {} : { transcript },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(b);
  cleanup.push(async () => {
    await client.close();
    await server.close();
    await fake.close();
  });
}

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

const transcript = async (args: Record<string, unknown>): Promise<Result> =>
  (await client.callTool({ name: "get_transcript", arguments: args })) as Result;

const page = async (args: Record<string, unknown>): Promise<Page> => {
  const result = await transcript(args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent as unknown as Page;
};

const user = (text: string): EntryMessage => ({ role: "user", text });
const answer = (text: string): EntryMessage => ({ role: "assistant", text });
const call = (name: string, args: unknown): EntryMessage => ({
  role: "assistant",
  text: "",
  calls: [`${name}(${JSON.stringify(args)})`],
});
const result = (text: string, isError = false): EntryMessage => ({
  role: "toolResult",
  text,
  isError,
});

describe("get_transcript", () => {
  it(
    "returns entries oldest first with calls, results, errors and usage",
    { timeout: TIMEOUT },
    async () => {
      await setup();
      const s = fake.addSession();
      fake.pushEntry(s.id, user("find it"), { kind: "pi.user" });
      fake.pushEntry(
        s.id,
        {
          role: "assistant",
          text: "searching",
          calls: ['web_search({"query":"cela"})', "bash"],
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01 },
        },
        { kind: "pi.assistant" },
      );
      fake.pushEntry(s.id, result("boom", true), { kind: "pi.tool-result" });
      fake.pushLive(s.id, LIVE_IDLE);

      const p = await page({ sessionId: s.id });
      expect(p).toMatchObject({ sessionId: s.id, cursor: 3, hasMore: false });
      expect(p.entries.map((e) => [e.id, e.kind])).toEqual([
        [1, "pi.user"],
        [2, "pi.assistant"],
        [3, "pi.tool-result"],
      ]);
      expect(p.entries[1]?.messages[0]).toEqual({
        role: "assistant",
        text: "searching",
        calls: [
          { name: "web_search", arguments: '{"query":"cela"}' },
          { name: "bash", arguments: "" },
        ],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01 },
      });
      expect(p.entries[2]?.messages[0]).toEqual({
        role: "toolResult",
        text: "boom",
        isError: true,
      });
      // Untrusted, like the other session tools.
      const first = (await transcript({ sessionId: s.id })).content[0]?.text ?? "";
      expect(first.startsWith("NOTE:")).toBe(true);
      expect(first).toContain("untrusted");
    },
  );

  it(
    "pages with the cursor and returns every entry exactly once",
    { timeout: TIMEOUT },
    async () => {
      await setup();
      const s = fake.addSession();
      for (let i = 1; i <= 7; i++) fake.pushEntry(s.id, answer(`a${String(i)}`));
      fake.pushLive(s.id, LIVE_IDLE);

      const seen: number[] = [];
      let cursor: number | undefined;
      let pages = 0;
      for (;;) {
        const p = await page({
          sessionId: s.id,
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...p.entries.map((e) => e.id));
        cursor = p.cursor;
        pages++;
        if (!p.hasMore) break;
        expect(p.entries).toHaveLength(3);
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(pages).toBe(3);
      // The cursor is sent as Last-Event-ID, so the server replays only what follows it.
      const ids = fake.requestsTo("GET", "/stream").map((r) => r.headers["last-event-id"]);
      expect(ids).toEqual([undefined, "3", "6"]);

      // Entries that arrive later are the next page, once.
      fake.pushEntry(s.id, answer("a8"));
      const more = await page({ sessionId: s.id, cursor });
      expect(more.entries.map((e) => e.id)).toEqual([8]);
      expect(more).toMatchObject({ cursor: 8, hasMore: false });
    },
  );

  it("says no more when the limit ends exactly at the end", { timeout: TIMEOUT }, async () => {
    await setup();
    const s = fake.addSession();
    fake.pushEntry(s.id, answer("a"));
    fake.pushEntry(s.id, answer("b"));
    fake.pushLive(s.id, LIVE_IDLE);
    expect(await page({ sessionId: s.id, limit: 2 })).toMatchObject({ cursor: 2, hasMore: false });
    expect(await page({ sessionId: s.id, limit: 1 })).toMatchObject({ cursor: 1, hasMore: true });
  });

  it("returns an empty page that keeps the cursor", { timeout: TIMEOUT }, async () => {
    await setup();
    const s = fake.addSession();
    fake.pushEntry(s.id, answer("a"));
    fake.pushLive(s.id, LIVE_IDLE);
    expect(await page({ sessionId: s.id, cursor: 1 })).toEqual({
      sessionId: s.id,
      entries: [],
      cursor: 1,
      hasMore: false,
    });
    const fresh = fake.addSession();
    fake.pushLive(fresh.id, LIVE_IDLE);
    const none = await page({ sessionId: fresh.id });
    expect(none).toEqual({ sessionId: fresh.id, entries: [], hasMore: false });
    expect(none).not.toHaveProperty("cursor");
  });

  it(
    "shows tool calls so far and their results once they finish",
    { timeout: TIMEOUT },
    async () => {
      await setup();
      const s = fake.addSession();
      fake.pushEntry(s.id, call("web_search", { query: "a" }));
      fake.pushLive(s.id, {
        running: true,
        queued: 0,
        tools: [{ callId: "c1", name: "web_search", status: "running" }],
      });
      const running = await page({ sessionId: s.id });
      expect(running.entries.map((e) => e.messages[0]?.calls?.[0]?.name)).toEqual(["web_search"]);
      fake.pushEntry(s.id, result("found"));
      const done = await page({ sessionId: s.id, cursor: running.cursor });
      expect(done.entries[0]?.messages[0]).toMatchObject({ role: "toolResult", text: "found" });
    },
  );

  it(
    "cuts large results and arguments per field and reports the original size",
    { timeout: TIMEOUT },
    async () => {
      await setup({ maxFieldBytes: 100 });
      const s = fake.addSession();
      fake.pushEntry(s.id, call("write", { content: "é".repeat(200) }));
      fake.pushEntry(s.id, result("x".repeat(5000)));
      fake.pushEntry(s.id, result("short"));
      fake.pushLive(s.id, LIVE_IDLE);

      const p = await page({ sessionId: s.id });
      const args = p.entries[0]?.messages[0]?.calls?.[0];
      expect(args?.truncated).toBe(true);
      expect(Buffer.byteLength(args?.arguments ?? "")).toBeLessThanOrEqual(100);
      expect(args?.length).toBe(Buffer.byteLength(JSON.stringify({ content: "é".repeat(200) })));
      // A cut never splits a multibyte character.
      expect(args?.arguments).not.toContain("�");
      expect(p.entries[1]?.messages[0]).toMatchObject({ truncated: true, length: 5000 });
      expect(p.entries[1]?.messages[0]?.text).toHaveLength(100);
      expect(p.entries[2]?.messages[0]).toEqual({
        role: "toolResult",
        text: "short",
        isError: false,
      });
    },
  );

  it(
    "keeps a response within the cap and continues where it stopped",
    { timeout: TIMEOUT },
    async () => {
      await setup({ maxFieldBytes: 1000, maxBytes: 3000 });
      const s = fake.addSession();
      for (let i = 1; i <= 6; i++) fake.pushEntry(s.id, result(String(i).repeat(1000)));
      fake.pushLive(s.id, LIVE_IDLE);

      const seen: number[] = [];
      let cursor: number | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await transcript({
          sessionId: s.id,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const p = res.structuredContent as unknown as Page;
        expect(Buffer.byteLength(JSON.stringify(p.entries))).toBeLessThanOrEqual(3000);
        expect(p.entries.length).toBeGreaterThan(0);
        seen.push(...p.entries.map((e) => e.id));
        cursor = p.cursor;
        if (!p.hasMore) break;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    },
  );

  it(
    "shrinks a first entry that cannot fit, and omits one that never will",
    { timeout: TIMEOUT },
    async () => {
      await setup({ maxFieldBytes: 1000, maxBytes: 600 });
      const s = fake.addSession();
      fake.pushEntry(s.id, [result("a".repeat(1000)), result("b".repeat(1000))]);
      fake.pushEntry(
        s.id,
        Array.from({ length: 50 }, (_, i) => result(`m${String(i)}`)),
      );
      fake.pushLive(s.id, LIVE_IDLE);
      const p = await page({ sessionId: s.id });
      expect(Buffer.byteLength(JSON.stringify(p.entries))).toBeLessThanOrEqual(600);
      expect(p.entries[0]?.messages.every((m) => m.truncated === true)).toBe(true);
      expect(p.hasMore).toBe(true);
      const next = await page({ sessionId: s.id, cursor: p.cursor });
      expect(next.entries[0]).toMatchObject({ id: 2, omitted: true, messages: [] });
      expect(next.entries[0]?.length).toBeGreaterThan(600);
      expect(next.hasMore).toBe(false);
    },
  );

  it(
    "filters by kinds and still advances the cursor over filtered entries",
    { timeout: TIMEOUT },
    async () => {
      await setup();
      const s = fake.addSession();
      fake.pushEntry(s.id, user("go"));
      fake.pushEntry(s.id, call("search", { q: 1 }));
      fake.pushEntry(s.id, result("ok"));
      fake.pushEntry(s.id, call("fetch", { u: 1 }));
      fake.pushEntry(s.id, result("denied", true));
      fake.pushEntry(s.id, answer("done"));
      fake.pushLive(s.id, LIVE_IDLE);

      const ids = async (kinds: string[], extra: Record<string, unknown> = {}): Promise<Page> =>
        page({ sessionId: s.id, kinds, ...extra });
      expect((await ids(["call", "error"])).entries.map((e) => e.id)).toEqual([2, 4, 5]);
      expect((await ids(["result"])).entries.map((e) => e.id)).toEqual([3, 5]);
      expect((await ids(["error"])).entries.map((e) => e.id)).toEqual([5]);
      expect((await ids(["user"])).entries.map((e) => e.id)).toEqual([1]);
      expect((await ids(["assistant"])).entries.map((e) => e.id)).toEqual([2, 4, 6]);
      // Caught up: the cursor is the last entry read, so an empty tail is not read again.
      expect(await ids(["call"])).toMatchObject({ cursor: 6, hasMore: false });
      // Paged, the filter holds across pages and no entry repeats.
      const first = await ids(["call", "error"], { limit: 2 });
      expect(first).toMatchObject({ cursor: 4, hasMore: true });
      const second = await ids(["call", "error"], { limit: 2, cursor: first.cursor });
      expect(second.entries.map((e) => e.id)).toEqual([5]);
      expect(second.hasMore).toBe(false);
    },
  );

  it(
    "stops reading after the scan cap and continues from the last entry read",
    { timeout: TIMEOUT },
    async () => {
      await setup({ maxScan: 3 });
      const s = fake.addSession();
      for (let i = 1; i <= 7; i++) fake.pushEntry(s.id, i === 5 ? call("x", {}) : answer("t"));
      fake.pushLive(s.id, LIVE_IDLE);
      const a = await page({ sessionId: s.id, kinds: ["call"] });
      expect(a).toMatchObject({ entries: [], cursor: 3, hasMore: true });
      const b = await page({ sessionId: s.id, kinds: ["call"], cursor: a.cursor });
      expect(b.entries.map((e) => e.id)).toEqual([5]);
      expect(b).toMatchObject({ cursor: 6, hasMore: true });
      const c = await page({ sessionId: s.id, kinds: ["call"], cursor: b.cursor });
      expect(c).toMatchObject({ entries: [], cursor: 7, hasMore: false });
    },
  );

  it("closes the stream when the page is done", { timeout: TIMEOUT }, async () => {
    await setup();
    const s = fake.addSession();
    fake.pushEntry(s.id, answer("a"));
    fake.pushLive(s.id, LIVE_IDLE);
    await page({ sessionId: s.id });
    await page({ sessionId: s.id, limit: 1 });
    await expect.poll(() => fake.openStreams(s.id)).toBe(0);
  });

  it(
    "fails rather than invent a page when the stream ends before it caught up",
    { timeout: TIMEOUT },
    async () => {
      await setup({ timeoutMs: 200 });
      const s = fake.addSession();
      fake.pushEntry(s.id, answer("a"));
      // No live event: the replay never reports that it caught up, so the read times out holding one entry.
      const partial = await page({ sessionId: s.id });
      expect(partial).toMatchObject({ cursor: 1, hasMore: true });
      expect(partial.entries).toHaveLength(1);
      const nothing = await transcript({ sessionId: s.id, cursor: 1 });
      expect(nothing.isError).toBe(true);
    },
  );

  it("rejects bad arguments before any request", { timeout: TIMEOUT }, async () => {
    await setup();
    const s = fake.addSession();
    for (const args of [
      { sessionId: s.id, cursor: 0 },
      { sessionId: s.id, cursor: 1.5 },
      { sessionId: s.id, limit: 0 },
      { sessionId: s.id, limit: 101 },
      { sessionId: s.id, kinds: [] },
      { sessionId: s.id, kinds: ["tool"] },
      { sessionId: "../admin/x" },
    ]) {
      expect((await transcript(args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("maps auth, ownership and session errors", { timeout: TIMEOUT }, async () => {
    await setup();
    // Another owner's session is a 404 to the caller, as for every session tool.
    const unknown = await transcript({ sessionId: "00000000-0000-4000-8000-000000000000" });
    expect(unknown).toMatchObject({
      isError: true,
      structuredContent: { error: "session not found", status: 404 },
    });
    const gone = fake.addSession({ status: "deleted" });
    const deleted = await transcript({ sessionId: gone.id });
    expect(deleted).toMatchObject({ isError: true, structuredContent: { status: 410 } });
    const s = fake.addSession();
    fake.failNextStream(s.id, { status: 503, retryAfter: 2 });
    expect((await transcript({ sessionId: s.id })).structuredContent).toMatchObject({
      status: 503,
      retryAfter: 2,
    });
    await cleanup.pop()?.();
    await setup(undefined, "wrong-token");
    const denied = await transcript({ sessionId: s.id });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: "the session API refused the token",
      status: 401,
    });
    expect(JSON.stringify(denied)).not.toContain("wrong-token");
  });

  it("fails when the session is deleted while it reads", { timeout: TIMEOUT }, async () => {
    await setup();
    const s = fake.addSession();
    fake.pushEntry(s.id, answer("a"));
    const reading = transcript({ sessionId: s.id });
    await fake.waitForStream(s.id);
    fake.pushDeleted(s.id);
    expect(await reading).toMatchObject({ isError: true, structuredContent: { status: 410 } });
  });
});
