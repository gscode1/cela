import {
  applyMigrations,
  backfillMcpCatalogRules,
  createPool,
  errorMessage,
  seedSettings,
  SettingsCache,
  readSettings,
  settingsEqual,
  tokenAuthenticator,
} from "@cela/session-core";
import { loadConfig } from "./config.js";
import { assertSessionShardRoutes, MissingShardRoutesError } from "./shard-routes.js";
import { log } from "./log.js";
import { createIngestServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const authenticate = tokenAuthenticator(config.apiTokens);
  const pool = createPool(config.databaseUrl, config.instance, 5, config.databaseTls);

  const settings = new SettingsCache(pool, { log });
  let schemaReady = false;
  const state = { stopping: false };
  const server = createIngestServer({
    pool,
    authenticate,
    orchestratorUrl: config.orchestratorUrl,
    shards: config.shards,
    settings,
    admins: config.admins,
    consoleDir: config.consoleDir,
    consoleCatalogs: config.consoleCatalogs,
    sandboxSizes: config.sandboxSizes,
    allowDirectSandboxEgress: config.allowDirectSandboxEgress,
    browserFlavourEnabled: config.browserFlavourEnabled,
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
        await applyMigrations(pool, undefined, process.env.PI_EGRESS_READER_ROLE || undefined);
        await assertSessionShardRoutes(pool, config.shards);
        // Seed once from the environment (a no-op when the row exists); after that the table wins.
        await seedSettings(pool, config.seed);
        const stored = await readSettings(pool);
        if (stored !== undefined && !settingsEqual(stored.settings, config.seed)) {
          log("settings-env-ignored", {
            message:
              "PI_MODEL_*, PI_SESSION_*_BUDGET and PI_REPO_ALLOWLIST differ from the settings table; the table wins",
          });
        }
        // Servers stored before migration 029 have no rule in `mcp-catalog` until a catalog write syncs them (ADR 0040).
        const derived = await backfillMcpCatalogRules(pool);
        for (const skipped of derived.skipped) log("mcp-catalog-skipped", skipped);
        await settings.start();
        schemaReady = true;
        log("migrated", { instance: config.instance });
        return;
      } catch (error) {
        if (error instanceof MissingShardRoutesError) {
          log("fatal", { message: error.message });
          process.exit(1);
        }
        log("migrate-failed", { message: errorMessage(error) });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  })();

  const shutdown = (signal: string): void => {
    log("shutdown", { signal });
    state.stopping = true;
    void settings.stop();
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
