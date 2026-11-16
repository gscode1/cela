import {
  applyMigrations,
  createPool,
  errorMessage,
  tokenAuthenticator,
} from "@pi-durable-k8s/session-core";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createIngestServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const authenticate = tokenAuthenticator(config.apiTokens);
  const pool = createPool(config.databaseUrl, config.instance, 5);

  let schemaReady = false;
  const state = { stopping: false };
  const server = createIngestServer({
    pool,
    authenticate,
    orchestratorUrl: config.orchestratorUrl,
    models: config.models,
    schemaReady: () => schemaReady,
  });
  // Long-lived SSE responses must not be cut by Node's default request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log("listening", { instance: config.instance, port: config.port });

  // The inbox schema is ingest's own precondition: it must accept events while the orchestrator is down. The server
  // is already up, so /healthz answers while a migration waits for a lock (a liveness failure would only restart
  // the pod into the same wait). Retry instead of crashing; /readyz stays 503 until it succeeds.
  void (async () => {
    while (!state.stopping) {
      try {
        await applyMigrations(pool);
        schemaReady = true;
        log("migrated", { instance: config.instance });
        return;
      } catch (error) {
        log("migrate-failed", { message: errorMessage(error) });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  })();

  const shutdown = (signal: string): void => {
    log("shutdown", { signal });
    state.stopping = true;
    server.close();
    server.closeAllConnections();
    void pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log("fatal", { message: errorMessage(error) });
  process.exit(1);
});
