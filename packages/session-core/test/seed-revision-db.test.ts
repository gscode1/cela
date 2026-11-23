import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.ts";

/** Against a real Postgres (see feed-db.test.ts for `CELA_TEST_DATABASE_URL`); each run makes and drops its own database. */
const url = process.env.CELA_TEST_DATABASE_URL;
const REPAIR = "037_coding_revision_bump.sql";

describe.skipIf(url === undefined)("migration 037 bumps coding's revision (issue #383)", () => {
  const name = `cela_rev_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let before: URL;
  let all: URL;

  beforeAll(async () => {
    const source = new URL("../migrations/", import.meta.url);
    const tmp = await mkdtemp(join(tmpdir(), "seed-revision-"));
    // `before` holds every migration except the repair, as a cluster upgraded from 034 would have run them.
    await cp(fileURLToPath(source), join(tmp, "before"), {
      recursive: true,
      filter: (path) => !path.endsWith(REPAIR),
    });
    before = pathToFileURL(join(tmp, "before") + "/");
    all = source;
    expect((await readdir(all)).includes(REPAIR)).toBe(true);

    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const target = new URL(url ?? "");
    target.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: target.toString(), max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${name}`);
    await admin.end();
  }, 60_000);

  const coding = async (): Promise<{ current_version: number; revision: number }> =>
    (
      await pool.query<{ current_version: number; revision: number }>(
        "select current_version, revision from inbox.profiles where name = 'coding'",
      )
    ).rows[0] ?? { current_version: 0, revision: 0 };

  it("raises the revision of a seed-written coding v4, once, and leaves an edited profile alone", async () => {
    await applyMigrations(pool, before);
    expect(await coding()).toEqual({ current_version: 4, revision: 1 });

    await applyMigrations(pool, all);
    expect(await coding()).toEqual({ current_version: 4, revision: 2 });

    // Recorded, so a restart does not bump again.
    await applyMigrations(pool, all);
    expect((await coding()).revision).toBe(2);
  }, 60_000);

  it("skips a profile an operator has written since", async () => {
    await pool.query("delete from inbox.schema_migrations where version = $1", [REPAIR]);
    await pool.query(
      "update inbox.profiles set updated_by = 'alice', revision = 5 where name = 'coding'",
    );
    await applyMigrations(pool, all);
    expect((await coding()).revision).toBe(5);
  }, 60_000);
});
