import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
/** Serialises concurrent starters (several ingest replicas plus the orchestrator). */
const LOCK_KEY = "pi-durable-k8s:inbox-migrate";
/**
 * How long DDL may wait for a lock. ALTER TABLE queues for ACCESS EXCLUSIVE and, while queued, blocks every other
 * query on the table; the orchestrator's inbox drain holds row locks for minutes while it prepares a repo workspace.
 * Failing fast lets the caller retry instead of stalling all traffic behind a migration that cannot run yet.
 */
const LOCK_TIMEOUT = "3s";
const UNDEFINED_TABLE = "42P01";

/**
 * Applies the inbox schema: every `NNN_*.sql` in order, each idempotent, each recorded in
 * `inbox.schema_migrations`. When every file is recorded this is one plain SELECT: no advisory lock, no DDL, so a
 * process restart never queues behind (or in front of) running traffic. Only a missing file takes the lock and runs.
 *
 * A database that predates the table has all files applied but nothing recorded; it takes the slow path once, the
 * idempotent files re-run (they change nothing) and are recorded, which is the backfill.
 */
export async function applyMigrations(pool: pg.Pool, dir: URL = MIGRATIONS): Promise<void> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied = await recordedVersions(pool);
  if (applied !== undefined && files.every((name) => applied.has(name))) return;

  const scripts = new Map(
    await Promise.all(
      files.map(async (name) => [name, await readFile(new URL(name, dir), "utf8")] as const),
    ),
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [LOCK_KEY]);
    // Another starter may have finished while this one waited for the lock.
    await client.query("create schema if not exists inbox");
    await client.query(
      `create table if not exists inbox.schema_migrations (
         version    text primary key,
         applied_at timestamptz not null default clock_timestamp()
       )`,
    );
    const done = await recordedVersions(client);
    for (const [name, sql] of scripts) {
      if (done?.has(name) === true) continue;
      await client.query(sql);
      await client.query("insert into inbox.schema_migrations (version) values ($1)", [name]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The recorded versions, or undefined while the table does not exist yet. */
async function recordedVersions(db: pg.Pool | pg.PoolClient): Promise<Set<string> | undefined> {
  try {
    const { rows } = await db.query<{ version: string }>(
      "select version from inbox.schema_migrations",
    );
    return new Set(rows.map((row) => row.version));
  } catch (error) {
    if ((error as { code?: string }).code === UNDEFINED_TABLE) return undefined;
    throw error;
  }
}
