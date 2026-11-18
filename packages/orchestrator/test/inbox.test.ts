import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDbRow, InboxEvent } from "@pi-durable-k8s/session-core";
import { retryDelayMs, InboxLoop } from "../src/inbox.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

/** In-memory inbox.events for one session, answering only the statements InboxLoop issues. */
class FakeInbox {
  rows: EventDbRow[] = [];
  /** Statements run on a transaction client, and on the pool outside one, in order. */
  readonly log: string[] = [];
  /** The pending-session polls (sql and parameters), in order. */
  readonly polls: { sql: string; params: unknown[] }[] = [];

  add(kind: EventDbRow["kind"], id = String(this.rows.length + 1)): EventDbRow {
    const row: EventDbRow = {
      id,
      session_id: SESSION,
      source: "test",
      source_event_id: id,
      kind,
      payload: {},
      status: "pending",
      attempts: 0,
      created_at: new Date(),
      submitted_at: null,
      error: null,
    };
    this.rows.push(row);
    return row;
  }

  /** True while the transaction has updated the session row and not committed: Postgres' row lock. */
  #sessionLocked = false;
  /** Updates of the session row that arrived on the pool while the transaction held its lock. */
  readonly blocked: string[] = [];

  #run(sql: string, params: unknown[], where: string): { rows: unknown[] } {
    this.log.push(`${where}: ${sql.trim().split("\n")[0] ?? ""}`);
    if (sql.startsWith("update inbox.sessions")) {
      if (where === "tx") this.#sessionLocked = true;
      else if (this.#sessionLocked) this.blocked.push(sql);
    }
    if (sql === "commit" || sql === "rollback") this.#sessionLocked = false;
    if (sql.includes("select e.session_id")) {
      this.polls.push({ sql, params });
      const skipped = (params[1] as string[]).includes(SESSION);
      const any = this.rows.some((r) => r.status === "pending");
      return { rows: any && !skipped ? [{ session_id: SESSION }] : [] };
    }
    if (sql.includes("select * from inbox.events")) {
      return { rows: this.rows.filter((r) => r.status === "pending") };
    }
    if (sql.includes("select * from inbox.sessions")) {
      return { rows: [{ id: SESSION, status: "deleting" }] };
    }
    if (sql.includes("set status = 'submitted'")) {
      const row = this.rows.find((r) => r.id === params[0]);
      if (row !== undefined) {
        row.status = "submitted";
        row.attempts = Number(params[1]);
      }
    }
    if (sql.includes("update inbox.events set status = $2")) {
      const row = this.rows.find((r) => r.id === params[0]);
      if (row !== undefined) {
        row.status = String(params[1]) as EventDbRow["status"];
        row.attempts = Number(params[2]);
        row.error = String(params[3]);
      }
    }
    return { rows: [] };
  }

  pool(): pg.Pool {
    const client = {
      query: (sql: string, params: unknown[] = []) => Promise.resolve(this.#run(sql, params, "tx")),
      release: () => undefined,
    };
    return {
      query: (sql: string, params: unknown[] = []) =>
        Promise.resolve(this.#run(sql, params, "pool")),
      connect: () => Promise.resolve(client),
    } as unknown as pg.Pool;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("retryDelayMs", () => {
  it("doubles from one second and stops at one minute", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(7)).toBe(60_000);
    expect(retryDelayMs(500)).toBe(60_000);
  });
});

describe("a failing delete", () => {
  it("is retried with backoff past five attempts and never ends failed", async () => {
    const inbox = new FakeInbox();
    const row = inbox.add("delete");
    let calls = 0;
    const apply = (): Promise<void> => {
      calls += 1;
      if (calls <= 8) return Promise.reject(new Error("kubernetes unavailable"));
      return Promise.resolve();
    };
    const loop = new InboxLoop(inbox.pool(), 0, apply);

    loop.wake();
    await flush();
    expect(calls).toBe(1);
    // Backoff: an immediate wake does not retry before the delay has passed.
    loop.wake();
    await flush();
    expect(calls).toBe(1);

    for (let i = 0; i < 20 && row.status !== "submitted"; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      loop.wake();
      await flush();
      expect(row.status).not.toBe("failed");
    }
    expect(calls).toBe(9);
    expect(row.status).toBe("submitted");
  });

  it("still ends a delete that can never succeed (PermanentError)", async () => {
    const { PermanentError } = await import("../src/sessions.ts");
    const inbox = new FakeInbox();
    const row = inbox.add("delete");
    const loop = new InboxLoop(inbox.pool(), 0, () => Promise.reject(new PermanentError("gone")));
    loop.wake();
    await flush();
    expect(row.status).toBe("failed");
  });

  it("other events still end failed once their attempts run out", async () => {
    const inbox = new FakeInbox();
    const row = inbox.add("message");
    const loop = new InboxLoop(inbox.pool(), 0, () => Promise.reject(new Error("boom")));
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      loop.wake();
      await flush();
    }
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(8);
  });
});

describe("a failing message or steer", () => {
  for (const kind of ["message", "steer"] as const) {
    it(`(${kind}) backs off and outlasts a short outage instead of failing within seconds`, async () => {
      const inbox = new FakeInbox();
      const row = inbox.add(kind);
      let calls = 0;
      const outageUntil = Date.now() + 60_000;
      const apply = (): Promise<void> => {
        calls += 1;
        return Date.now() < outageUntil
          ? Promise.reject(new Error("onecli unavailable"))
          : Promise.resolve();
      };
      const loop = new InboxLoop(inbox.pool(), 0, apply);
      loop.wake();
      await flush();
      expect(calls).toBe(1);
      // An immediate wake (the 1 s poll) does not retry before the backoff has passed.
      loop.wake();
      await flush();
      expect(calls).toBe(1);
      // The poll keeps waking the loop every second through a one-minute outage.
      for (let t = 0; t < 120 && row.status === "pending"; t++) {
        vi.setSystemTime(Date.now() + 1_000);
        loop.wake();
        await flush();
      }
      expect(row.status).toBe("submitted");
      expect(calls).toBeLessThan(10);
    });
  }

  it("is held back after a failed prepare as well", async () => {
    const inbox = new FakeInbox();
    const row = inbox.add("message");
    let prepares = 0;
    const prepare = (): Promise<void> => {
      prepares += 1;
      return Promise.reject(new Error("github 502"));
    };
    const loop = new InboxLoop(inbox.pool(), 0, () => Promise.resolve(), prepare);
    loop.wake();
    await flush();
    loop.wake();
    await flush();
    expect(prepares).toBe(1);
    expect(row.status).toBe("pending");
  });
});

describe("the pending poll", () => {
  it("leaves backed-off sessions out and serves the oldest pending event first", async () => {
    const inbox = new FakeInbox();
    inbox.add("delete");
    const loop = new InboxLoop(inbox.pool(), 0, () =>
      Promise.reject(new Error("kubernetes unavailable")),
    );
    loop.wake();
    await flush();
    // The failed delete put the session into backoff, so the next poll must pass it as skipped.
    loop.wake();
    await flush();
    expect(inbox.polls).toHaveLength(2);
    expect(inbox.polls[0]?.params[1]).toEqual([]);
    expect(inbox.polls[1]?.params[1]).toEqual([SESSION]);
    for (const { sql } of inbox.polls) {
      expect(sql).toContain("order by min(e.created_at)");
      expect(sql).toContain("limit 100");
    }
    // Once the backoff has passed the session is polled (and retried) again.
    vi.setSystemTime(Date.now() + 61_000);
    loop.wake();
    await flush();
    expect(inbox.polls[2]?.params[1]).toEqual([]);
  });
});

describe("the LISTEN connection", () => {
  it("is released when stop() ran while the connect was pending", async () => {
    let resolveConnect: (client: pg.PoolClient) => void = () => undefined;
    const pool = {
      connect: () => new Promise<pg.PoolClient>((resolve) => (resolveConnect = resolve)),
      query: () => Promise.resolve({ rows: [] }),
    } as unknown as pg.Pool;
    const loop = new InboxLoop(pool, 0, () => Promise.resolve());
    loop.start();
    await loop.stop();
    const release = vi.fn();
    const on = vi.fn();
    resolveConnect({
      release,
      on,
      query: vi.fn(),
      removeAllListeners: vi.fn(),
    } as unknown as pg.PoolClient);
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(true), { timeout: 2_000 });
    expect(on).not.toHaveBeenCalled();
  });
});

describe("a batch with a message followed by a delete", () => {
  it("never updates the session row from the pool while the batch transaction holds it", async () => {
    const inbox = new FakeInbox();
    const message = inbox.add("message");
    const del = inbox.add("delete");
    const pool = inbox.pool();
    // What the real #delete does: mark the session deleted on the pool, not on the batch's connection.
    const apply = async (event: InboxEvent): Promise<void> => {
      if (event.kind === "delete") {
        await pool.query("update inbox.sessions set status = 'deleted' where id = $1", [SESSION]);
      }
    };
    const loop = new InboxLoop(pool, 0, apply);
    loop.wake();
    await flush();

    expect(message.status).toBe("submitted");
    expect(del.status).toBe("submitted");
    // Before the fix the first row's last_activity update held the lock and the delete's update waited on it.
    expect(inbox.blocked).toEqual([]);
    // The idle clock is still bumped, once for the batch, after the commit.
    const touches = inbox.log.filter((l) => l.includes("set last_activity_at"));
    expect(touches).toEqual([
      "pool: update inbox.sessions set last_activity_at = clock_timestamp() where id = $1",
    ]);
    expect(inbox.log.indexOf("tx: commit")).toBeLessThan(inbox.log.indexOf(touches[0] ?? ""));
  });
});
