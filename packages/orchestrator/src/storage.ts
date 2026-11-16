import type { Storage } from "@earendil-works/pi-durable";
import { openNodePostgresStorage } from "@netzlabor/pi-durable-postgres";
import { createPool } from "@pi-durable-k8s/session-core";
import type { OrchestratorConfig } from "./config.js";
import { errorMessage, log } from "./log.js";

/**
 * Connection settings against silent drops: TCP keepalive notices a dead peer in about a minute, and
 * the statement timeout turns a hung query into a failure (which fails the Harness closed) instead of
 * a hang. The adapter pins one connection, so `max: 1` is all it can use.
 */
export function poolConfig(config: OrchestratorConfig): Record<string, unknown> {
  return {
    connectionString: config.databaseUrl,
    options: `-c search_path=${config.schema}`,
    application_name: config.instance,
    max: 1,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  };
}

const LOCK_HELD = /only one owner is supported|in use/;

/**
 * The adapter's lock query uses `current_schema()`, which is NULL when the schema does not exist, and reports that
 * as "in use or its schema does not exist". Only a lookup of the schema tells the two apart.
 */
async function schemaExists(config: OrchestratorConfig): Promise<boolean> {
  const pool = createPool(config.databaseUrl, `${config.instance}-schema-probe`, 1);
  try {
    const { rowCount } = await pool.query("select 1 from pg_namespace where nspname = $1", [
      config.schema,
    ]);
    return rowCount === 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Creates the shard's schema. `deploy/postgres.yaml` creates only the first one, at initdb, and a shard added later
 * has none. The name was validated in `shardSchema`, so quoting it is enough.
 */
async function ensureSchema(config: OrchestratorConfig): Promise<void> {
  const pool = createPool(config.databaseUrl, `${config.instance}-schema-create`, 1);
  try {
    await pool.query(`create schema if not exists "${config.schema}"`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export interface StorageDeps {
  /** Run once before the first open; a failure is retried like a failed open. */
  ensureSchema: (config: OrchestratorConfig) => Promise<void>;
  open: (config: OrchestratorConfig) => Promise<Storage>;
  schemaExists: (config: OrchestratorConfig) => Promise<boolean>;
}

const REAL: StorageDeps = {
  ensureSchema,
  open: (config) => openNodePostgresStorage({ config: poolConfig(config) }),
  schemaExists,
};

/**
 * Opens the storage, and waits while another orchestrator owns the schema. The adapter refuses a
 * second owner immediately instead of blocking, so "blocking on the lock" is this retry loop. Other
 * failures (database not reachable yet) are retried the same way; secrets are never in these messages.
 * A schema that does not exist is logged as such, not as a held lock.
 */
export async function openStorageWhenFree(
  config: OrchestratorConfig,
  signal: AbortSignal,
  retryMs = 2_000,
  deps: StorageDeps = REAL,
): Promise<Storage> {
  let waitingLogged = false;
  let schemaEnsured = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      if (!schemaEnsured) {
        await deps.ensureSchema(config);
        schemaEnsured = true;
      }
      return await deps.open(config);
    } catch (error) {
      const message = errorMessage(error);
      const missing =
        LOCK_HELD.test(message) && !(await deps.schemaExists(config).catch(() => true));
      if (missing) {
        log("storage-schema-missing", {
          instance: config.instance,
          schema: config.schema,
          message,
        });
      } else if (LOCK_HELD.test(message)) {
        if (!waitingLogged) log("waiting-for-lock", { instance: config.instance });
        waitingLogged = true;
      } else {
        log("storage-open-failed", { instance: config.instance, message });
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
