import type { Storage } from "@earendil-works/pi-durable";
import { openNodePostgresStorage } from "@netzlabor/pi-durable-postgres";
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
 * Opens the storage, and waits while another orchestrator owns the schema. The adapter refuses a
 * second owner immediately instead of blocking, so "blocking on the lock" is this retry loop. Other
 * failures (database not reachable yet) are retried the same way; secrets are never in these messages.
 */
export async function openStorageWhenFree(
  config: OrchestratorConfig,
  signal: AbortSignal,
  retryMs = 2_000,
): Promise<Storage> {
  let waitingLogged = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await openNodePostgresStorage({ config: poolConfig(config) });
    } catch (error) {
      const message = errorMessage(error);
      if (LOCK_HELD.test(message)) {
        if (!waitingLogged) log("waiting-for-lock", { instance: config.instance });
        waitingLogged = true;
      } else {
        log("storage-open-failed", { instance: config.instance, message });
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
