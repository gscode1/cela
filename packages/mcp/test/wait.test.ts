import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, SessionApi } from "../src/api.js";
import { clampTimeoutSec, waitForSession, type WaitResult } from "../src/wait.js";
import { assistant, FakeApi, user, type FakeSession } from "./fake-api.js";

const TIMEOUT = 10_000;
const FAST = { pollMs: 20, idleMs: 30 };
const IDLE = { running: false, queued: 0 };

let fake: FakeApi;
let api: SessionApi;

beforeEach(async () => {
  fake = await FakeApi.start();
  api = new SessionApi({ apiUrl: fake.url, token: fake.token });
});
afterEach(async () => {
  await fake.close();
});

function wait(
  s: FakeSession,
  opts: { cursor?: number; ms?: number; maxBytes?: number } = {},
): Promise<WaitResult> {
  return waitForSession(
    api,
    {
      sessionId: s.id,
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      deadline: Date.now() + (opts.ms ?? 3000),
    },
    { ...FAST, ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) },
  );
}

const noLeak = (s: FakeSession): Promise<void> =>
  vi.waitFor(() => expect(fake.openStreams(s.id)).toBe(0), { timeout: 2000 });

describe("clampTimeoutSec", () => {
  it("defaults to 45 and clamps to 1..50", { timeout: TIMEOUT }, () => {
    expect(clampTimeoutSec()).toBe(45);
    expect(clampTimeoutSec(Number.NaN)).toBe(45);
    expect(clampTimeoutSec(0)).toBe(1);
    expect(clampTimeoutSec(200)).toBe(50);
    expect(clampTimeoutSec(10)).toBe(10);
  });
});

describe("waitForSession", () => {
  it(
    "is done on idle after the answer: assistant text only, with the cursor",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushEntry(s.id, [user("q"), assistant("one"), assistant("two")]);
      fake.pushEntry(s.id, { role: "toolResult", text: "secret tool output" });
      fake.pushLive(s.id, IDLE);
      const r = await wait(s);
      expect(r).toMatchObject({
        done: true,
        status: "active",
        cursor: 2,
        text: "one\n\ntwo",
        truncated: false,
        events: { pending: 0, submitted: 0, failed: 0 },
      });
      expect(r.runFailure).toBeUndefined();
      await noLeak(s);
    },
  );

  it(
    "is not done while a row is pending, and ignores a stale idle",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession({ events: { pending: 1 } });
      fake.pushLive(s.id, IDLE); // stale: from before the message was picked up
      let result: WaitResult | undefined;
      const p = wait(s).then((r) => (result = r));
      await fake.waitForStream(s.id);
      await new Promise((r) => setTimeout(r, 200));
      expect(result).toBeUndefined();
      expect(fake.streamConnections(s.id)).toBe(1);

      s.events.pending = 0;
      s.events.submitted = 1;
      fake.pushEntry(s.id, assistant("answer"));
      const r = await p;
      expect(r).toMatchObject({ done: true, text: "answer", cursor: 1 });
      // The idle that counted came from a connection opened after the GET that showed pending 0.
      expect(fake.streamConnections(s.id)).toBe(2);
    },
  );

  it(
    "does not trust an idle while running, and waits for the idle",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushLive(s.id, { running: true, queued: 0 });
      const p = wait(s);
      await fake.waitForStream(s.id);
      fake.pushEntry(s.id, assistant("working"));
      fake.pushLive(s.id, IDLE);
      expect(await p).toMatchObject({ done: true, text: "working", cursor: 1 });
    },
  );

  it(
    "reports runFailure, and clears it when a later live shows running",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushLive(s.id, { ...IDLE, runFailure: "model exploded" });
      expect(await wait(s)).toMatchObject({ done: true, runFailure: "model exploded" });

      const s2 = fake.addSession();
      fake.pushLive(s2.id, { ...IDLE, runFailure: "old" });
      const p = wait(s2);
      await fake.waitForStream(s2.id);
      fake.pushLive(s2.id, { running: true, queued: 0 });
      fake.pushLive(s2.id, IDLE);
      const r = await p;
      expect(r.done).toBe(true);
      expect(r.runFailure).toBeUndefined();
    },
  );

  it(
    "reports a message that failed during the wait as failedSinceStart",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession({ events: { failed: 1, pending: 1 } });
      const p = wait(s);
      await vi.waitFor(() => expect(fake.openStreams(s.id)).toBe(1), { timeout: 2000 });
      // The orchestrator gives up on the message: it leaves `pending` and ends `failed`.
      s.events.pending = 0;
      s.events.failed = 2;
      fake.pushLive(s.id, IDLE);
      const r = await p;
      expect(r).toMatchObject({ done: true, text: "", failedSinceStart: 1, phase: "idle" });
      // Failures from before the call are not counted, and none means no field.
      const old = fake.addSession({ events: { failed: 3 } });
      fake.pushLive(old.id, IDLE);
      expect((await wait(old)).failedSinceStart).toBeUndefined();
    },
  );

  it("reports phase, tools and elapsedSec", { timeout: TIMEOUT }, async () => {
    const created = new Date(Date.now() - 90_000).toISOString();
    const queued = fake.addSession({ createdAt: created, events: { pending: 1 } });
    const first = await wait(queued, { ms: 100 });
    expect(first).toMatchObject({ done: false, phase: "pending" });
    expect(first.tools).toBeUndefined();
    expect(first.elapsedSec).toBeGreaterThanOrEqual(90);
    expect(first.elapsedSec).toBeLessThan(100);

    const running = fake.addSession();
    fake.pushLive(running.id, {
      running: true,
      queued: 0,
      tools: [
        { callId: "1", name: "bash", status: "running" },
        { callId: "2", name: "bash", status: "running" },
        { callId: "3", name: "read", status: "done" },
      ],
    });
    expect(await wait(running, { ms: 100 })).toMatchObject({
      done: false,
      phase: "running",
      tools: ["bash", "read"],
    });

    const idle = fake.addSession();
    fake.pushLive(idle.id, { ...IDLE, tools: [{ callId: "1", name: "bash", status: "done" }] });
    const r = await wait(idle);
    expect(r).toMatchObject({ done: true, phase: "idle" });
    expect(r.tools).toBeUndefined();
  });

  it("reports events.failed", { timeout: TIMEOUT }, async () => {
    const s = fake.addSession({ events: { failed: 2, submitted: 3 } });
    fake.pushLive(s.id, IDLE);
    expect((await wait(s)).events).toEqual({ pending: 0, submitted: 3, failed: 2 });
  });

  it(
    "returns the cursor at the deadline and a second call resumes without loss or duplicates",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushLive(s.id, { running: true, queued: 0 });
      fake.pushEntry(s.id, assistant("a"));
      fake.pushEntry(s.id, { role: "toolResult", text: "x" });
      const first = await wait(s, { ms: 150 });
      expect(first).toMatchObject({ done: false, text: "a", cursor: 2 });

      fake.pushEntry(s.id, assistant("b"));
      fake.pushLive(s.id, IDLE);
      const second = await wait(s, { cursor: 2 });
      expect(second).toMatchObject({ done: true, text: "b", cursor: 3 });
      await noLeak(s);
    },
  );

  it(
    "keeps entries intact across a reconnect after pending reaches 0",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession({ events: { pending: 1 } });
      fake.pushEntry(s.id, assistant("early"));
      const p = wait(s);
      await fake.waitForStream(s.id);
      await new Promise((r) => setTimeout(r, 60));
      s.events.pending = 0;
      fake.pushEntry(s.id, assistant("late"));
      fake.pushLive(s.id, IDLE);
      expect(await p).toMatchObject({ done: true, text: "early\n\nlate", cursor: 2 });
    },
  );

  it(
    "stops before an entry that would exceed the cap, and finishes in the next call",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushEntry(s.id, assistant("a".repeat(15_000)));
      fake.pushEntry(s.id, assistant("b".repeat(15_000)));
      fake.pushLive(s.id, IDLE);
      const first = await waitForSession(
        api,
        { sessionId: s.id, deadline: Date.now() + 3000 },
        FAST,
      );
      expect(first).toMatchObject({ done: false, truncated: true, cursor: 1 });
      expect(first.text).toBe("a".repeat(15_000));

      const second = await waitForSession(
        api,
        { sessionId: s.id, cursor: 1, deadline: Date.now() + 3000 },
        FAST,
      );
      expect(second).toMatchObject({ done: true, truncated: false, cursor: 2 });
      expect(second.text).toBe("b".repeat(15_000));
      await noLeak(s);
    },
  );

  it(
    "cuts a single oversize entry at a UTF-8 boundary and moves past it",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession();
      fake.pushEntry(s.id, assistant("é".repeat(20_000))); // 40000 bytes
      fake.pushEntry(s.id, assistant("next"));
      fake.pushLive(s.id, IDLE);
      const r = await wait(s, { maxBytes: 1001 }); // odd cap: the cut must back off inside "é"
      expect(r.truncated).toBe(true);
      expect(r.cursor).toBe(1);
      expect(r.done).toBe(false); // "next" does not fit after the cut entry
      expect(r.text.endsWith("\n[… truncated]")).toBe(true);
      expect(r.text).not.toContain("�");
      const body = r.text.slice(0, -"\n[… truncated]".length);
      expect(Buffer.byteLength(body)).toBe(1000);
      expect(body).toBe("é".repeat(500));

      const next = await wait(s, { cursor: 1 });
      expect(next).toMatchObject({ done: true, text: "next", cursor: 2 });
    },
  );

  it("reports a deleted session seen mid-stream as done", { timeout: TIMEOUT }, async () => {
    const s = fake.addSession();
    fake.pushLive(s.id, { running: true, queued: 0 });
    const p = wait(s);
    await fake.waitForStream(s.id);
    fake.pushDeleted(s.id);
    expect(await p).toMatchObject({ done: true, status: "deleted" });
  });

  it("reports a failed session", { timeout: TIMEOUT }, async () => {
    const s = fake.addSession({ status: "failed", failure: "boom" });
    expect(await wait(s)).toMatchObject({ done: true, status: "failed", failure: "boom" });
    expect(fake.streamConnections(s.id)).toBe(0);
  });

  it("returns done:false on a stream 503", { timeout: TIMEOUT }, async () => {
    const s = fake.addSession();
    fake.failNextStream(s.id, { status: 503, retryAfter: 1 });
    expect(await wait(s)).toMatchObject({ done: false, status: "active" });
    await noLeak(s);
  });

  it("returns done:false, not an error, when the stream drops", { timeout: TIMEOUT }, async () => {
    const s = fake.addSession();
    fake.pushLive(s.id, { running: true, queued: 0 });
    fake.pushEntry(s.id, assistant("partial"));
    const p = wait(s);
    await fake.waitForStream(s.id);
    await new Promise((r) => setTimeout(r, 50));
    fake.dropStreams(s.id);
    expect(await p).toMatchObject({ done: false, text: "partial", cursor: 1 });
    await noLeak(s);
  });

  it(
    "returns done:false when the API is unreachable after the first GET",
    { timeout: TIMEOUT },
    async () => {
      const s = fake.addSession({ events: { pending: 1 } });
      const p = wait(s);
      await fake.waitForStream(s.id);
      await fake.close();
      expect((await p).done).toBe(false);
      // afterEach closes again: make that safe
      fake = await FakeApi.start();
    },
  );

  it(
    "throws ApiError for an unknown session and for a bad token",
    { timeout: TIMEOUT },
    async () => {
      const deadline = Date.now() + 1000;
      await expect(
        waitForSession(api, { sessionId: randomUUID(), deadline }, FAST),
      ).rejects.toMatchObject({
        status: 404,
      });
      const s = fake.addSession();
      const bad = new SessionApi({ apiUrl: fake.url, token: "wrong-token-value" });
      await expect(waitForSession(bad, { sessionId: s.id, deadline }, FAST)).rejects.toBeInstanceOf(
        ApiError,
      );
    },
  );
});
