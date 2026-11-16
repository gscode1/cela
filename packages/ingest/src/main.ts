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

  // The inbox schema is ingest's own precondition: it must accept events while the orchestrator is down.
  // Retry instead of crashing, so a database that is briefly unreachable does not restart-loop the pod.
  for (;;) {
    try {
      await applyMigrations(pool);
      break;
    } catch (error) {
      log("migrate-failed", { message: errorMessage(error) });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  const server = createIngestServer({
    pool,
    authenticate,
    orchestratorUrl: config.orchestratorUrl,
    models: config.models,
  });
  // Long-lived SSE responses must not be cut by Node's default request timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log("listening", { instance: config.instance, port: config.port });

  const shutdown = (signal: string): void => {
    log("shutdown", { signal });
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
