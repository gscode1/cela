import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EventDbRow, InboxEvent, SessionRow } from "@cela/session-core";
import { InboxLoop } from "../src/inbox.ts";
import { GithubDeniedError } from "../src/github-app.ts";
import type { Host } from "../src/host.ts";
import { PermanentError, SessionService } from "../src/sessions.ts";
import { CloneTargetNotFoundError, WorkspaceLostError } from "../src/workspace.ts";
import type { RepoAccess } from "../src/repo-access.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";

/** A pool that knows when a transaction is open and how many clients are checked out. */
class FakePool {
  rows: EventDbRow[] = [];
  txOpen = false;
  clientsOut = 0;
  readonly trace: string[] = [];
  /** Runs once, right after the first read of pending rows (the prepare phase's snapshot). */
  afterSnapshot: (() => void) | undefined;

  add(kind: EventDbRow["kind"], id = String(this.rows.length + 1)): EventDbRow {
    const row: EventDbRow = {
      id,
      session_id: SESSION,
      source: "test",
      source_event_id: id,
      kind,
      payload: { text: "hi" },
      status: "pending",
      attempts: 0,
      created_at: new Date(),
      submitted_at: null,
      error: null,
    };
    this.rows.push(row);
    return row;
  }

  #run(sql: string, params: unknown[]): { rows: unknown[] } {
    if (sql === "begin") this.txOpen = true;
    if (sql === "commit" || sql === "rollback") this.txOpen = false;
    if (sql.includes("select e.session_id")) {
      return {
        rows: this.rows.some((r) => r.status === "pending") ? [{ session_id: SESSION }] : [],
      };
    }
    if (sql.includes("select * from inbox.events")) {
      const snapshot = this.rows.filter((r) => r.status === "pending");
      const hook = this.afterSnapshot;
      this.afterSnapshot = undefined;
      hook?.();
      return { rows: snapshot };
    }
    if (sql.includes("select * from inbox.sessions")) {
      return { rows: [{ id: SESSION, status: "active" }] };
    }
    if (sql.includes("set status = 'submitted'")) {
      const row = this.rows.find((r) => r.id === params[0]);
      if (row !== undefined) row.status = "submitted";
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
    return {
      query: (sql: string, params: unknown[] = []) => Promise.resolve(this.#run(sql, params)),
      connect: () => {
        this.clientsOut += 1;
        return Promise.resolve({
          query: (sql: string, params: unknown[] = []) => Promise.resolve(this.#run(sql, params)),
          release: () => {
            this.clientsOut -= 1;
          },
        });
      },
    } as unknown as pg.Pool;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("the prepare phase of the inbox drain", () => {
  it("holds no transaction and no pool client while it runs, then claims and submits", async () => {
    const db = new FakePool();
    const row = db.add("message");
    const seen: { txOpen: boolean; clientsOut: number }[] = [];
    const loop = new InboxLoop(
      db.pool(),
      0,
      () => {
        db.trace.push("apply");
        return Promise.resolve();
      },
      async () => {
        seen.push({ txOpen: db.txOpen, clientsOut: db.clientsOut });
        await new Promise((resolve) => setTimeout(resolve, 20));
        seen.push({ txOpen: db.txOpen, clientsOut: db.clientsOut });
        db.trace.push("prepare");
      },
    );
    loop.wake();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await flush();
    expect(seen).toEqual([
      { txOpen: false, clientsOut: 0 },
      { txOpen: false, clientsOut: 0 },
    ]);
    expect(db.trace).toEqual(["prepare", "apply"]);
    expect(row.status).toBe("submitted");
  });

  it("leaves rows pending when apply fails after prepare, and prepares again on the retry", async () => {
    // The crash-before-mark shape: the claim rolls back, and the retry must not depend on the first prepare.
    const db = new FakePool();
    const row = db.add("message");
    let prepares = 0;
    let applies = 0;
    const loop = new InboxLoop(
      db.pool(),
      0,
      () => {
        applies += 1;
        return applies === 1 ? Promise.reject(new Error("died")) : Promise.resolve();
      },
      () => {
        prepares += 1;
        return Promise.resolve();
      },
    );
    loop.wake();
    await flush();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    // The retry waits out the backoff.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2_000);
      loop.wake();
      await flush();
    } finally {
      vi.useRealTimers();
    }
    expect(row.status).toBe("submitted");
    expect(prepares).toBe(2);
  });

  it("records a transient prepare failure on the row and does not apply it or the rows behind it", async () => {
    const db = new FakePool();
    const first = db.add("message");
    const second = db.add("message");
    const applied: string[] = [];
    const loop = new InboxLoop(
      db.pool(),
      0,
      (event) => {
        applied.push(event.id);
        return Promise.resolve();
      },
      () => Promise.reject(new Error("clone timed out")),
    );
    loop.wake();
    await flush();
    expect(applied).toEqual([]);
    expect([first.status, first.attempts, first.error]).toEqual(["pending", 1, "clone timed out"]);
    expect(second.status).toBe("pending");
    expect(db.txOpen).toBe(false);
  });

  it("applies a cancel in front of the failing input, never overtaking it with later rows", async () => {
    const db = new FakePool();
    const cancel = db.add("cancel");
    const message = db.add("message");
    const later = db.add("message");
    const loop = new InboxLoop(
      db.pool(),
      0,
      () => Promise.resolve(),
      () => Promise.reject(new Error("transient")),
    );
    loop.wake();
    await flush();
    expect(cancel.status).toBe("submitted");
    expect(message.status).toBe("pending");
    expect(later.status).toBe("pending");
  });

  it("ends the row for good on a permanent prepare failure and goes on with the next", async () => {
    const db = new FakePool();
    const first = db.add("message");
    const second = db.add("message");
    const loop = new InboxLoop(
      db.pool(),
      0,
      () => Promise.resolve(),
      (event) =>
        event.id === first.id ? Promise.reject(new PermanentError("no access")) : Promise.resolve(),
    );
    loop.wake();
    await flush();
    expect([first.status, first.error]).toEqual(["failed", "no access"]);
    expect(second.status).toBe("submitted");
  });

  it("prepares for the next input before submitting it after a terminal prepare failure", async () => {
    const db = new FakePool();
    const first = db.add("message");
    const second = db.add("message");
    const trace: string[] = [];
    const loop = new InboxLoop(
      db.pool(),
      0,
      (event) => {
        trace.push(`apply ${event.id}`);
        return Promise.resolve();
      },
      (event) => {
        trace.push(`prepare ${event.id}`);
        return event.id === first.id
          ? Promise.reject(new PermanentError("no access"))
          : Promise.resolve();
      },
    );
    loop.wake();
    await flush();
    expect(first.status).toBe("failed");
    expect(second.status).toBe("submitted");
    expect(trace).toEqual([`prepare ${first.id}`, `prepare ${second.id}`, `apply ${second.id}`]);
  });

  it("never submits an input that arrived after a cancel-only snapshot without preparing for it", async () => {
    const db = new FakePool();
    db.add("cancel");
    let late: EventDbRow | undefined;
    db.afterSnapshot = () => {
      late = db.add("message");
    };
    const trace: string[] = [];
    const loop = new InboxLoop(
      db.pool(),
      0,
      (event) => {
        trace.push(`apply ${event.kind}`);
        return Promise.resolve();
      },
      (event) => {
        trace.push(`prepare ${event.kind}`);
        return Promise.resolve();
      },
    );
    loop.wake();
    await flush();
    expect(late?.status).toBe("submitted");
    expect(trace).toEqual(["apply cancel", "prepare message", "apply message"]);
  });

  it("gives up on a repeatedly failing prepare after its attempts like any other event", async () => {
    const db = new FakePool();
    const row = db.add("message");
    const loop = new InboxLoop(
      db.pool(),
      0,
      () => Promise.resolve(),
      () => Promise.reject(new Error("boom")),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(Date.now() + 61_000);
        loop.wake();
        await flush();
      }
    } finally {
      vi.useRealTimers();
    }
    expect([row.status, row.attempts]).toEqual(["failed", 8]);
  });

  it("does not prepare in front of a delete, only for what follows it", async () => {
    const db = new FakePool();
    db.add("delete");
    db.add("message");
    const trace: string[] = [];
    const loop = new InboxLoop(
      db.pool(),
      0,
      (event) => {
        trace.push(`apply ${event.kind}`);
        return Promise.resolve();
      },
      (event) => {
        trace.push(`prepare ${event.kind}`);
        return Promise.resolve();
      },
    );
    loop.wake();
    await flush();
    // The delete is applied with no clone; the message behind it is prepared for (a no-op for a deleted session)
    // before apply, never submitted unprepared.
    expect(trace).toEqual(["apply delete", "prepare message", "apply message"]);
  });
});

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION,
  owner: "alice",
  ownerSubject: "static:alice",
  status: "active",
  shard: 0,
  conversationId: 7,
  model: null,
  failure: null,
  repo: { repo: "octo/hello" },
  onecli: null,
  workspaceReadyAt: null,
  profile: null,
  usage: null,
  sandboxSize: null,
  networkMode: "proxied",
  sandboxFlavour: "default",
  sandboxRuntime: null,
  createdAt: new Date(),
  lastActivityAt: new Date(),
  ...overrides,
});

const message: InboxEvent = {
  id: "1",
  sessionId: SESSION,
  source: "api:alice",
  sourceEventId: "m1",
  kind: "message",
  payload: { text: "hi" },
  status: "pending",
  attempts: 0,
  createdAt: new Date(),
  submittedAt: null,
  error: null,
};

function service(prepare: () => Promise<void>) {
  const calls = { prepare: 0, submit: 0, failed: 0 };
  const failures: unknown[] = [];
  const pool = {
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes("set status = 'failed'")) {
        calls.failed += 1;
        failures.push(params?.[1]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as pg.Pool;
  const host = {
    workspaceEnv: () => Promise.resolve({}),
    abort: () => Promise.resolve(),
    applyProfileTools: () => Promise.resolve(),
    runTurns: () => Promise.resolve(0),
    turnsUsed: () => Promise.resolve(0),
    limitTurns: () => Promise.resolve(),
    hasSubmission: () => Promise.resolve(false),
    submitInput: () => {
      calls.submit += 1;
      return Promise.resolve();
    },
  } as unknown as Host;
  const repos = {
    prepare: () => {
      calls.prepare += 1;
      return prepare();
    },
  } as unknown as RepoAccess;
  const svc = new SessionService(pool, host, {
    shard: 0,
    testFaults: false,
    defaultModel: { provider: "p", model: "m" },
    turnBudget: () => 5,
    repos,
  });
  return { svc, calls, failures };
}

describe("SessionService.prepare", () => {
  it("does the repo work, and apply no longer does it", async () => {
    const { svc, calls } = service(() => Promise.resolve());
    await svc.prepare(message, sessionRow());
    expect(calls.prepare).toBe(1);
    await svc.apply(message, sessionRow({ workspaceReadyAt: new Date() }));
    expect(calls).toMatchObject({ prepare: 1, submit: 1 });
  });

  it("refuses to submit to a repo session whose workspace was never prepared", async () => {
    const { svc, calls } = service(() => Promise.resolve());
    await expect(svc.apply(message, sessionRow())).rejects.toThrow(/not prepared/);
    expect(calls.submit).toBe(0);
    // A plain session has no workspace to prepare.
    await svc.apply(message, sessionRow({ repo: null }));
    expect(calls.submit).toBe(1);
  });

  it("is safe to run again", async () => {
    const { svc, calls } = service(() => Promise.resolve());
    await svc.prepare(message, sessionRow());
    await svc.prepare(message, sessionRow());
    expect(calls.prepare).toBe(2);
  });

  it("does nothing for a plain session, a cancel, a failed session or an input without text", async () => {
    const { svc, calls } = service(() => Promise.resolve());
    await svc.prepare(message, sessionRow({ repo: null }));
    await svc.prepare({ ...message, kind: "cancel" }, sessionRow());
    await svc.prepare(message, sessionRow({ status: "failed" }));
    await svc.prepare({ ...message, payload: {} }, sessionRow());
    expect(calls.prepare).toBe(0);
  });

  it("turns a lost workspace and a GitHub refusal into a failed session and a permanent error", async () => {
    for (const error of [
      new WorkspaceLostError("workspace is missing"),
      new GithubDeniedError("x"),
    ]) {
      const { svc, calls } = service(() => Promise.reject(error));
      await expect(svc.prepare(message, sessionRow())).rejects.toBeInstanceOf(PermanentError);
      expect(calls.failed).toBe(1);
    }
  });

  it("fails the session at once, with a fixed message, when the branch or repository does not exist", async () => {
    for (const [what, text] of [
      ["branch", 'Cannot clone: branch "nope" does not exist in octo/hello'],
      [
        "repository",
        "Cannot clone: repository octo/hello does not exist or is not accessible to the GitHub App",
      ],
    ] as const) {
      const { svc, calls, failures } = service(() =>
        Promise.reject(new CloneTargetNotFoundError({ repo: "octo/hello", branch: "nope" }, what)),
      );
      await expect(svc.prepare(message, sessionRow())).rejects.toBeInstanceOf(PermanentError);
      expect(calls.failed).toBe(1);
      expect(failures).toEqual([text]);
    }
  });

  it("keeps a plain clone failure (network error) transient: no session failure", async () => {
    const { svc, calls } = service(() =>
      Promise.reject(new Error("git clone failed (exit 128): Could not resolve host")),
    );
    const error = await svc.prepare(message, sessionRow()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PermanentError);
    expect(calls.failed).toBe(0);
  });

  it("neither prepares nor runs an input queued in front of a delete (session deleting)", async () => {
    const { svc, calls } = service(() => Promise.resolve());
    for (const kind of ["message", "steer"] as const) {
      const input = { ...message, kind };
      const deleting = sessionRow({ status: "deleting", workspaceReadyAt: new Date() });
      await svc.prepare(input, deleting);
      await expect(svc.apply(input, deleting)).rejects.toBeInstanceOf(PermanentError);
    }
    expect(calls).toMatchObject({ prepare: 0, submit: 0 });
  });

  it("lets a transient error through as is, to be retried", async () => {
    const { svc } = service(() => Promise.reject(new Error("timeout")));
    await expect(svc.prepare(message, sessionRow())).rejects.toThrow("timeout");
  });
});
