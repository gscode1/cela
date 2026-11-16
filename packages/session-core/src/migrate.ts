import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
/** Serialises concurrent starters (several ingest replicas plus the orchestrator). */
const LOCK_KEY = "pi-durable-k8s:inbox-migrate";

/** Applies the inbox schema: every `NNN_*.sql` in order, each idempotent. Safe to call from every process at every start. */
export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  const scripts = await Promise.all(
    files.map((name) => readFile(new URL(name, MIGRATIONS), "utf8")),
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [LOCK_KEY]);
    for (const sql of scripts) await client.query(sql);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
