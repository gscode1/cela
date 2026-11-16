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
  const db = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
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
    );
    expect(calls[0]?.params.at(-1)).toBe(3);
    expect(calls[0]?.sql).toMatch(/generate_series\(0, \$12::int - 1\)/);
    expect(calls[0]?.sql).toMatch(/status = 'active'/);
    expect(calls[0]?.sql).toMatch(/order by coalesce\(a\.n, 0\), c\.shard limit 1/);
  });

  it("createSession defaults to a single shard", async () => {
    const { calls, db } = recorder();
    await createSession(db, { owner: "a", subject: "s" }, { provider: "p", model: "m" });
    expect(calls[0]?.params.at(-1)).toBe(1);
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
