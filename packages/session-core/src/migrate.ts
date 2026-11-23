import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
/** Serialises concurrent starters (several ingest replicas plus the orchestrator). */
const LOCK_KEY = "cela:inbox-migrate";
/**
 * How long DDL may wait for a lock. ALTER TABLE queues for ACCESS EXCLUSIVE and, while queued, blocks every other
 * query on the table; the orchestrator's inbox drain holds row locks for minutes while it prepares a repo workspace.
 * Failing fast lets the caller retry instead of stalling all traffic behind a migration that cannot run yet.
 */
const LOCK_TIMEOUT = "3s";
const UNDEFINED_TABLE = "42P01";

/**
 * Applies the inbox schema: every `NNN_*.sql` in order, each idempotent, each recorded in
 * `inbox.schema_migrations`. A current schema with complete reader grants uses only SELECTs: no advisory lock or DDL.
 * Missing migrations or reader grants take the same lock, so concurrent starters cannot race their repairs.
 *
 * A database that predates the table has all files applied but nothing recorded; it takes the slow path once, the
 * idempotent files re-run (they change nothing) and are recorded, which is the backfill.
 * Returns a missing reader role for the caller to warn about; grants are rechecked on the next start.
 */
export async function applyMigrations(
  pool: pg.Pool,
  dir: URL = MIGRATIONS,
  egressReaderRole?: string,
): Promise<{ missingEgressReaderRole: string | undefined }> {
  if (
    egressReaderRole !== undefined &&
    (egressReaderRole.length === 0 ||
      Buffer.byteLength(egressReaderRole) > 63 ||
      egressReaderRole.includes("\0"))
  ) {
    throw new Error("PI_EGRESS_READER_ROLE must be a Postgres role name of 1 to 63 bytes");
  }
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied = await recordedVersions(pool);
  const current = applied !== undefined && files.every((name) => applied.has(name));
  if (current) {
    const reader = await readerGrantsState(pool, egressReaderRole);
    if (reader !== "incomplete") {
      return { missingEgressReaderRole: reader === "missing" ? egressReaderRole : undefined };
    }
  }

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
    if (!current) {
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
    }
    const reader = await readerGrantsState(client, egressReaderRole);
    if (reader === "incomplete") {
      await client.query("select egress.grant_proxy_reader($1::name)", [egressReaderRole]);
    }
    await client.query("commit");
    return { missingEgressReaderRole: reader === "missing" ? egressReaderRole : undefined };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Mirrors grant_proxy_reader (027), including column-only access to principals: never grant token_salt. */
async function readerGrantsState(
  db: pg.Pool | pg.PoolClient,
  role: string | undefined,
): Promise<"complete" | "incomplete" | "missing"> {
  if (role === undefined) return "complete";
  const found = await db.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1) as exists",
    [role],
  );
  if (found.rows[0]?.exists !== true) return "missing";
  const { rows } = await db.query<{ complete: boolean }>(
    `select has_schema_privilege($1::name, 'egress', 'USAGE')
       and (select bool_and(has_table_privilege($1::name, t, 'SELECT'))
              from unnest(array['egress.revisions', 'egress.rule_sets', 'egress.rules', 'egress.bindings']) as t)
       and (select bool_and(has_column_privilege($1::name, 'egress.principals', c, 'SELECT'))
              from unnest(array['session_id', 'token_hash', 'profile_name', 'profile_version',
                                'rule_sets', 'pod_ip', 'created_at', 'revoked_at']) as c)
       and (select bool_and(has_table_privilege($1::name, 'egress.proxy_status', p))
              from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p) as complete`,
    [role],
  );
  return rows[0]?.complete === true ? "complete" : "incomplete";
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
