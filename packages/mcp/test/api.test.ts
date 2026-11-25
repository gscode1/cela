import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, SessionApi } from "../src/api.js";
import { assistant, FakeApi } from "./fake-api.js";

let fake: FakeApi;
let api: SessionApi;

beforeEach(async () => {
  fake = await FakeApi.start();
  api = new SessionApi({ apiUrl: fake.url, token: fake.token });
});
afterEach(async () => {
  await fake.close();
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected a rejection");
}

describe("SessionApi", { timeout: 15_000 }, () => {
  it("creates, reads, posts to and deletes a session with the bearer token", async () => {
    const created = await api.createSession({ profile: "coding", repo: "o/r" });
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.requests[0]?.body).toEqual({ profile: "coding", repo: "o/r" });

    const posted = await api.postEvent(created.sessionId, {
      kind: "message",
      text: "hi",
      sourceEventId: "k1",
    });
    expect(posted.duplicate).toBe(false);
    expect(fake.requests[1]?.body).toEqual({ kind: "message", text: "hi", sourceEventId: "k1" });
    await api.postEvent(created.sessionId, { kind: "cancel" });
    expect(fake.requests[2]?.body).toEqual({ kind: "cancel" });

    const summary = await api.getSession(created.sessionId);
    expect(summary).toMatchObject({ status: "active", events: { pending: 1 } });
    expect(await api.deleteSession(created.sessionId)).toEqual({
      sessionId: created.sessionId,
      status: "deleted",
    });
    expect(fake.session(created.sessionId).status).toBe("deleted");

    for (const r of fake.requests) expect(r.headers.authorization).toBe(`Bearer ${fake.token}`);
  });

  it("reports a repeated sourceEventId as duplicate", async () => {
    const s = fake.addSession();
    const first = await api.postEvent(s.id, { kind: "message", text: "a", sourceEventId: "k" });
    const again = await api.postEvent(s.id, { kind: "message", text: "a", sourceEventId: "k" });
    expect(again).toEqual({ eventId: first.eventId, duplicate: true });
  });

  it("maps 401 for a wrong token", async () => {
    const wrong = new SessionApi({ apiUrl: fake.url, token: "wrong-token-value" });
    const error = await rejection(wrong.createSession());
    expect(error.status).toBe(401);
    expect(error.message).toBe("unauthorized");
  });

  it("maps 404, 409 and 410", async () => {
    const unknown = await rejection(api.getSession("11111111-2222-3333-4444-555555555555"));
    expect(unknown.status).toBe(404);

    const failed = fake.addSession({ status: "failed", failure: "boom" });
    const conflict = await rejection(api.postEvent(failed.id, { kind: "message", text: "x" }));
    expect(conflict.status).toBe(409);
    expect(conflict.message).toBe("session is failed");

    const other = fake.addSession();
    await api.postEvent(other.id, { kind: "message", text: "x", sourceEventId: "shared" });
    const mine = fake.addSession();
    const reused = await rejection(
      api.postEvent(mine.id, { kind: "message", text: "x", sourceEventId: "shared" }),
    );
    expect(reused.status).toBe(409);

    const gone = fake.addSession({ status: "deleted" });
    expect((await rejection(api.postEvent(gone.id, { kind: "cancel" }))).status).toBe(410);
  });

  it("refuses a bad session id before any request", async () => {
    for (const id of [
      "",
      "abc",
      "../admin/settings",
      "11111111-2222-3333-4444-55555555555?x=1",
      "%2e%2e",
    ]) {
      const error = await rejection(api.getSession(id));
      expect(error.status).toBe(0);
      await rejection(api.postEvent(id, { kind: "cancel" }));
      await rejection(api.deleteSession(id));
      await rejection(api.openStream(id, undefined, new AbortController().signal));
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a bad cursor before any request", async () => {
    const s = fake.addSession();
    for (const cursor of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await rejection(api.openStream(s.id, cursor, new AbortController().signal));
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("does not follow redirects, so the token is not forwarded", async () => {
    const elsewhere = await FakeApi.start();
    try {
      fake.redirectTo = `${elsewhere.url}/sessions`;
      const error = await rejection(api.createSession());
      expect(error.status).toBe(0);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });

  it("keeps the token out of error messages, even when the server echoes it", async () => {
    const s = fake.addSession();
    fake.failNextCreate = { status: 400, error: `bad token ${fake.token} given` };
    const echoed = await rejection(api.createSession());
    expect(echoed.status).toBe(400);
    expect(echoed.message).not.toContain(fake.token);

    const dead = new SessionApi({ apiUrl: "http://127.0.0.1:1", token: fake.token });
    const network = await rejection(dead.getSession(s.id));
    expect(network.status).toBe(0);
    expect(network.message).not.toContain(fake.token);
    expect(JSON.stringify(network)).not.toContain(fake.token);
  });

  it("openStream returns the raw response: sends Last-Event-ID, replays after it, passes errors through", async () => {
    const s = fake.addSession();
    fake.pushEntry(s.id, assistant("one"));
    const second = fake.pushEntry(s.id, assistant("two"));
    const ctl = new AbortController();
    const res = await api.openStream(s.id, second - 1, ctl.signal);
    expect(res.status).toBe(200);
    expect(fake.requests[0]?.headers["last-event-id"]).toBe(String(second - 1));
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${fake.token}`);
    const reader = res.body?.getReader();
    const text = new TextDecoder().decode((await reader?.read())?.value);
    expect(text).toContain("retry: 2000");
    ctl.abort();

    fake.failNextStream(s.id, { status: 503, retryAfter: 7 });
    const down = await api.openStream(s.id, undefined, new AbortController().signal);
    expect(down.status).toBe(503);
    const error = await api.errorFromResponse(down);
    expect(error).toMatchObject({ status: 503, retryAfter: 7 });

    fake.failNextStream(s.id, { status: 410, body: { error: "session deleted" } });
    const gone = await api.openStream(s.id, undefined, new AbortController().signal);
    expect((await api.errorFromResponse(gone)).status).toBe(410);
  });

  it("passes liveView on create and returns liveViewUrl", async () => {
    const created = await api.createSession({ profile: "desktop", liveView: true });
    expect(fake.requests[0]?.body).toEqual({ profile: "desktop", liveView: true });
    expect(created.liveViewUrl).toMatch(/^https:\/\//);
  });

  it("enableLiveView PUTs and returns a new URL each time; disableLiveView DELETEs", async () => {
    const s = fake.addSession();
    const a = await api.enableLiveView(s.id);
    const b = await api.enableLiveView(s.id);
    expect(a).not.toBe(b);
    expect(fake.requests[0]).toMatchObject({
      method: "PUT",
      path: `/sessions/${s.id}/live-view`,
      body: undefined,
    });
    await api.disableLiveView(s.id);
    await api.disableLiveView(s.id);
    expect(fake.requestsTo("DELETE", "/live-view")).toHaveLength(2);
    for (const r of fake.requests) expect(r.headers.authorization).toBe(`Bearer ${fake.token}`);
  });

  it("maps live view errors 400, 409 and 410, and refuses a bad id", async () => {
    const s = fake.addSession();
    fake.failNextLiveView = { status: 400, error: "not a desktop session" };
    expect(await rejection(api.enableLiveView(s.id))).toMatchObject({
      status: 400,
      message: "not a desktop session",
    });
    const failed = fake.addSession({ status: "failed" });
    expect((await rejection(api.enableLiveView(failed.id))).status).toBe(409);
    const gone = fake.addSession({ status: "deleted" });
    expect((await rejection(api.disableLiveView(gone.id))).status).toBe(410);
    const before = fake.requests.length;
    await rejection(api.enableLiveView("nope"));
    await rejection(api.disableLiveView("nope"));
    expect(fake.requests).toHaveLength(before);
  });
});
