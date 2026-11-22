import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneFeed, readFeed } from "../src/feed.ts";
import type { FeedPage } from "../src/feed.ts";
import { applyMigrations } from "../src/migrate.ts";

/**
 * Against a real Postgres, because the guarantee under test is Postgres's snapshot semantics. Set
 * `CELA_TEST_DATABASE_URL` to a server where the user may create databases; CI does (check.yml). Each run creates and
 * drops its own database.
 */
const url = process.env.CELA_TEST_DATABASE_URL;

// CI must run them: a skip there would hide the one test of the cursor guarantee.
it.runIf(process.env.CI === "true")("has a test database in CI", () => {
  expect(url).toBeDefined();
});

describe.skipIf(url === undefined)("the owner feed on Postgres (ADR 0058)", () => {
  const name = `cela_feed_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const target = new URL(url ?? "");
    target.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: target.toString(), max: 6 });
    await applyMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
  }, 60_000);

  const session = async (subject: string, db: pg.Pool | pg.PoolClient = pool): Promise<string> => {
    const id = randomUUID();
    await db.query(
      "insert into inbox.sessions (id, owner, owner_subject, profile_name) values ($1, 'o', $2, 'coding')",
      [id, subject],
    );
    return id;
  };

  const drain = async (subject: string, cursor?: string): Promise<FeedPage["events"]> => {
    const seen: FeedPage["events"] = [];
    let at = cursor === undefined ? undefined : parse(cursor);
    for (;;) {
      const page = await readFeed(pool, subject, at, 2);
      seen.push(...page.events);
      at = parse(page.cursor);
      if (!page.hasMore) return seen;
    }
  };
  const parse = (cursor: string) => {
    const [xid = "0", id = "0"] = cursor.split("-");
    return { xid, id };
  };

  it(
    "never skips a row whose transaction took its id first and committed last",
    { timeout: 30_000 },
    async () => {
      const subject = `static:${randomUUID()}`;
      const early = await pool.connect();
      try {
        await early.query("begin");
        // The early transaction writes first: its row gets the lower id and the lower xid.
        const slow = await session(subject, early);
        const fast = await session(subject);
        // Read while the early transaction is still open: the committed later row is held back, not returned.
        const before = await readFeed(pool, subject, undefined);
        expect(before.events.map((e) => e.sessionId)).not.toContain(fast);
        await early.query("commit");
        const after = await readFeed(pool, subject, parse(before.cursor));
        expect(after.events.map((e) => e.sessionId)).toEqual([slow, fast]);
      } finally {
        early.release();
      }
    },
  );

  it(
    "records status changes and input outcomes, scoped to the owner",
    { timeout: 30_000 },
    async () => {
      const alice = `static:${randomUUID()}`;
      const bob = `static:${randomUUID()}`;
      const id = await session(alice);
      await session(bob);
      const { rows } = await pool.query<{ id: string }>(
        "insert into inbox.events (session_id, source, source_event_id, kind) values ($1, 's', $2, 'message') returning id",
        [id, randomUUID()],
      );
      const eventId = rows[0]?.id ?? "";
      await pool.query(
        "update inbox.events set status = 'submitted', outcome = 'unanswered', outcome_reason = 'model_error', settled_at = now() where id = $1",
        [eventId],
      );
      await pool.query("update inbox.sessions set status = 'failed', failure = 'x' where id = $1", [
        id,
      ]);
      // A change of another column writes nothing.
      await pool.query("update inbox.sessions set last_activity_at = now() where id = $1", [id]);
      const events = await drain(alice);
      expect(events.map((e) => [e.type, e.data])).toEqual([
        ["session.created", { profile: "coding" }],
        [
          "input.settled",
          {
            eventId,
            kind: "message",
            status: "submitted",
            outcome: "unanswered",
            reason: "model_error",
          },
        ],
        ["session.status", { status: "failed", failure: "x" }],
      ]);
      expect(events.every((e) => e.sessionId === id)).toBe(true);
    },
  );

  it(
    "starts at the head with latest, and reports a cursor older than the horizon as truncated",
    { timeout: 30_000 },
    async () => {
      const subject = `static:${randomUUID()}`;
      await session(subject);
      const head = await readFeed(pool, subject, "latest");
      expect(head.events).toEqual([]);
      const next = await session(subject);
      expect((await drain(subject, head.cursor)).map((e) => e.sessionId)).toEqual([next]);

      await pool.query(
        "update inbox.feed set created_at = created_at - interval '10 days' where owner_subject = $1",
        [subject],
      );
      expect(await pruneFeed(pool, 24)).toBeGreaterThanOrEqual(2);
      const resumed = await readFeed(pool, subject, { xid: "0", id: "0" });
      expect(resumed.truncated).toBe(true);
      expect(resumed.events).toEqual([]);
      // No cursor means "what is retained": not a gap.
      expect((await readFeed(pool, subject, undefined)).truncated).toBe(false);
    },
  );
});
