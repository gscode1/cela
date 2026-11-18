import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  conversationsWithExecInFlight,
  createSession,
  sessionByConversation,
  setExecInFlight,
} from "../src/store.ts";

/** Records the statements; answers with the rows it was given. */
function recorder(rows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // The session insert returns its id; every other statement answers with the given rows.
    const answer = sql.includes("insert into inbox.sessions") ? [{ id: params[0] }] : rows;
    return Promise.resolve({ rows: answer, rowCount: answer.length });
  };
  const db = { query, connect: () => Promise.resolve({ query, release: () => undefined }) };
  return { calls, db: db as unknown as pg.Pool };
}

describe("sharded store functions", () => {
  it("createSession passes the shard count and picks by fewest active sessions in the insert", async () => {
    const { calls, db } = recorder();
    await createSession(
      db,
      { owner: "a", subject: "s" },
      { provider: "p", model: "m" },
      undefined,
      undefined,
      3,
      "m",
    );
    // One transaction: the catalog lock shared (ADR 0027), then the insert.
    expect(calls.map((call) => call.sql.split("(")[0]?.trim())).toEqual([
      "begin",
      "select pg_advisory_xact_lock_shared",
      "insert into inbox.sessions",
      "commit",
    ]);
    const insert = calls[2];
    // $12 is the shard count, $13 the sandbox size (ADR 0030).
    expect(insert?.params[11]).toBe(3);
    expect(insert?.params[12]).toBe("m");
    expect(insert?.sql).toMatch(/shard, sandbox_size, network_mode, sandbox_flavour\)/);
    expect(insert?.sql).toMatch(/generate_series\(0, \$12::int - 1\)/);
    expect(insert?.sql).toMatch(/status = 'active'/);
    expect(insert?.sql).toMatch(/order by coalesce\(a\.n, 0\), c\.shard limit 1/);
  });

  it("createSession defaults to a single shard", async () => {
    const { calls, db } = recorder();
    await createSession(db, { owner: "a", subject: "s" }, { provider: "p", model: "m" });
    const params = calls.find((call) => call.sql.includes("insert into inbox.sessions"))?.params;
    expect(params?.[11]).toBe(1);
    // No size: the session uses the unsized pool.
    expect(params?.[12]).toBeNull();
  });

  it("looks a session up by shard and conversation id together", async () => {
    const { calls, db } = recorder();
    expect(await sessionByConversation(db, 1, 5)).toBeUndefined();
    expect(calls[0]?.sql).toMatch(/where shard = \$1 and conversation_id = \$2/);
    expect(calls[0]?.params).toEqual([1, 5]);
  });

  it("scopes the exec-in-flight marker and its recovery to a shard", async () => {
    const { calls, db } = recorder();
    await setExecInFlight(db, 2, 7, true);
    expect(calls[0]?.sql).toMatch(/where shard = \$1 and conversation_id = \$2/);
    expect(calls[0]?.params).toEqual([2, 7, true]);
    await conversationsWithExecInFlight(db, 2);
    expect(calls[1]?.sql).toMatch(/where shard = \$1/);
    expect(calls[1]?.params).toEqual([2]);
  });
});
