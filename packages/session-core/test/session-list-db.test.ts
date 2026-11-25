import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.ts";
import { listSessions, parseSessionCursor } from "../src/session-list.ts";
import type { SessionListItem } from "../src/session-list.ts";

/** Against a real Postgres, like feed-db.test.ts: the keyset order and the owner scope are SQL. */
const url = process.env.CELA_TEST_DATABASE_URL;

it.runIf(process.env.CI === "true")("has a test database in CI", () => {
  expect(url).toBeDefined();
});

describe.skipIf(url === undefined)("listSessions on Postgres", () => {
  const name = `cela_list_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const target = new URL(url ?? "");
    target.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: target.toString(), max: 4 });
    await applyMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
  }, 60_000);

  const add = async (
    owner: string,
    createdAt: string,
    status = "active",
    id: string = randomUUID(),
  ): Promise<string> => {
    await pool.query(
      `insert into inbox.sessions (id, owner, owner_subject, status, profile_name, profile_version, created_at)
       values ($1, $2, $3, $4, 'coding', 2, $5)`,
      [id, owner, `static:${owner}`, status, createdAt],
    );
    return id;
  };

  const drain = async (query: Parameters<typeof listSessions>[1]): Promise<SessionListItem[]> => {
    const seen: SessionListItem[] = [];
    let cursor = query.cursor;
    for (;;) {
      const page = await listSessions(pool, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.sessions);
      if (page.nextCursor === undefined) return seen;
      cursor = parseSessionCursor(page.nextCursor);
      expect(cursor).toBeDefined();
    }
  };

  it("pages newest first without repeating or skipping a row, even at equal and microsecond times", async () => {
    const owner = `o${randomUUID().slice(0, 8)}`;
    const ids = [
      await add(owner, "2026-11-25T10:00:00.000001Z"),
      await add(owner, "2026-11-25T10:00:00.000002Z"),
      // Two rows in the same microsecond: the id breaks the tie.
      await add(
        owner,
        "2026-11-25T10:00:00.000003Z",
        "active",
        "00000000-0000-4000-8000-000000000001",
      ),
      await add(
        owner,
        "2026-11-25T10:00:00.000003Z",
        "active",
        "00000000-0000-4000-8000-000000000002",
      ),
      await add(owner, "2026-11-25T09:00:00Z"),
    ];
    const all = await drain({ ownerSubject: `static:${owner}`, limit: 2 });
    expect(all.map((s) => s.id)).toEqual([ids[3], ids[2], ids[1], ids[0], ids[4]]);
    expect(all[0]).toMatchObject({
      status: "active",
      profile: { name: "coding", version: 2 },
      model: null,
      repo: null,
    });
  });

  it("scopes to the owner subject and hides other owners' ids", async () => {
    const mine = `o${randomUUID().slice(0, 8)}`;
    const theirs = `o${randomUUID().slice(0, 8)}`;
    const own = await add(mine, "2026-11-25T10:00:00Z");
    const other = await add(theirs, "2026-11-25T10:00:01Z");
    const seen = (await drain({ ownerSubject: `static:${mine}`, limit: 50 })).map((s) => s.id);
    expect(seen).toEqual([own]);
    const all = await drain({ limit: 50, withOwner: true });
    expect(all.filter((s) => [own, other].includes(s.id)).map((s) => [s.id, s.owner])).toEqual([
      [other, theirs],
      [own, mine],
    ]);
    expect((await drain({ owner: theirs, limit: 50, withOwner: true })).map((s) => s.id)).toEqual([
      other,
    ]);
  });

  it("excludes deleted sessions unless asked and filters by status", async () => {
    const owner = `o${randomUUID().slice(0, 8)}`;
    const active = await add(owner, "2026-11-25T10:00:00Z");
    const deleted = await add(owner, "2026-11-25T10:00:01Z", "deleted");
    const failed = await add(owner, "2026-11-25T10:00:02Z", "failed");
    const subject = `static:${owner}`;
    expect((await drain({ ownerSubject: subject, limit: 50 })).map((s) => s.id)).toEqual([
      failed,
      active,
    ]);
    expect(
      (await drain({ ownerSubject: subject, status: "deleted", limit: 50 })).map((s) => s.id),
    ).toEqual([deleted]);
    expect(
      (await drain({ ownerSubject: subject, status: "failed", limit: 50 })).map((s) => s.id),
    ).toEqual([failed]);
  });

  it("returns metadata fields only", async () => {
    const owner = `o${randomUUID().slice(0, 8)}`;
    await add(owner, "2026-11-25T10:00:00Z");
    const [item] = await drain({ ownerSubject: `static:${owner}`, limit: 1 });
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "lastActivityAt",
      "model",
      "profile",
      "repo",
      "status",
    ]);
  });
});
