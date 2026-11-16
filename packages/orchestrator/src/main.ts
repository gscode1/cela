import {
  applyMigrations,
  conversationsWithExecInFlight,
  createPool,
  errorMessage,
  getSession,
  listSessionRefs,
  setExecInFlight,
  tokenAuthenticator,
} from "@pi-durable-k8s/session-core";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./github-app.js";
import { OneCliAdmin } from "./onecli-admin.js";
import { RepoAccess } from "./repo-access.js";
import type { SandboxHooks } from "./sandboxes.js";
import { Host } from "./host.js";
import { createOrchestratorServer } from "./http.js";
import type { Lifecycle } from "./http.js";
import { InboxLoop } from "./inbox.js";
import { listClaims, listPvcs } from "./kube.js";
import { log } from "./log.js";
import { SessionService } from "./sessions.js";
import { createShutdown } from "./shutdown.js";
import type { Running } from "./shutdown.js";
import { openStorageWhenFree } from "./storage.js";
import { OrphanSweeper } from "./sweeper.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const lifecycle: Lifecycle = { state: "waiting-for-lock", instance: config.instance };
  // A second, independent connection pool for the inbox and the owner check: the Pi Durable adapter pins its
  // own connection and holds the ownership lock on it, and neither may share it.
  const pool = createPool(config.databaseUrl, `${config.instance}-inbox`, 10);
  const server = createOrchestratorServer({
    lifecycle,
    authenticate: tokenAuthenticator(config.apiTokens),
    pool,
    control: config.control,
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log("listening", { instance: config.instance, port: config.port });

  const running: Running = {};
  const stop = new AbortController();
  const shutdown = createShutdown({
    running,
    stop,
    server,
    pool,
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  for (;;) {
    try {
      await applyMigrations(pool);
      break;
    } catch (error) {
      log("migrate-failed", { message: errorMessage(error) });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  const storage = await openStorageWhenFree(config, stop.signal);
  log("lock-acquired", { instance: config.instance });
  const sessionKeyOf = async (conversationId: number): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      "select id from inbox.sessions where conversation_id = $1",
      [conversationId],
    );
    // Conversations the inbox does not know are the test-only /control sessions.
    return rows[0]?.id ?? `control-${String(conversationId)}`;
  };
  // Repo workspaces (Phase 4c). Plain sessions never touch OneCLI's management API or GitHub through this.
  const callApi: FetchLike = (url, init) => fetch(url, init);
  const onecli =
    config.repos.onecliApiKey === undefined
      ? undefined
      : new OneCliAdmin(config.repos.onecliApi, config.repos.onecliApiKey, callApi);
  const repos = new RepoAccess({
    pool,
    onecli,
    githubAppDir: config.repos.githubAppDir,
    gateway: config.onecli.gateway,
    caFile: config.onecli.caFile,
    fetch: callApi,
  });
  const hooks: SandboxHooks = {
    shellEnv: async (conversationId) => {
      const { rows } = await pool.query<{ id: string }>(
        "select id from inbox.sessions where conversation_id = $1",
        [conversationId],
      );
      const session = rows[0] === undefined ? undefined : await getSession(pool, rows[0].id);
      return session === undefined ? undefined : repos.shellEnv(session, conversationId);
    },
    beforeUse: (conversationId) => repos.beforeUse(conversationId),
    envStale: (conversationId) => repos.envStale(conversationId),
    execInFlight: (conversationId, inFlight) => setExecInFlight(pool, conversationId, inFlight),
  };
  // Sandboxes that had a command running when the previous process died: Host.open recycles their Pods before Pi
  // Durable resumes (docs/decisions/0003-recycle-pod-on-interrupt.md).
  const recycleAtStart = await conversationsWithExecInFlight(pool);
  if (recycleAtStart.length > 0) log("recycle-at-start", { conversations: recycleAtStart });
  const opening = Host.open(
    storage,
    config,
    (error) => {
      // Fail closed: a Harness that lost its storage stops here. Nothing reconnects and nothing more is
      // written; the Deployment starts a fresh process, which waits for the lock like any other owner.
      log("fail-closed", { instance: config.instance, message: errorMessage(error) });
      process.exit(1);
    },
    sessionKeyOf,
    hooks,
    recycleAtStart,
  );
  // Visible to the signal handler before Host.open settles, so a shutdown in that window still closes the host.
  running.opening = opening;
  const host = await opening;
  running.host = host;
  if (stop.signal.aborted) return;
  const service = new SessionService(pool, host, {
    testFaults: config.testFaults,
    defaultModel: config.models.default,
    turnBudget: config.turnBudget,
    repos,
  });
  running.service = service;
  // Not fatal: a failed scan only means a run that died unseen is noticed at its next input.
  await service.recoverWatches().catch((error: unknown) => {
    log("run-watch-recover-failed", { message: errorMessage(error) });
  });
  if (stop.signal.aborted) return; // shutdown began during recovery: do not start the sweeper and inbox after it
  lifecycle.host = host;
  lifecycle.service = service;
  lifecycle.state = "owner";
  log("owner", { instance: config.instance });

  // Orphan sweep (docs/decisions/0002-orphan-sweep.md): only the owner runs it, like the inbox.
  const sweeper = new OrphanSweeper({
    listSessions: () => listSessionRefs(pool),
    listClaims: () => listClaims(config.namespace),
    listPvcs: () => listPvcs(config.namespace),
    listOneCli:
      onecli === undefined
        ? undefined
        : async () => ({
            agents: (await onecli.listAgents()).map(({ id, identifier }) => ({ id, identifier })),
            secrets: await onecli.listSecrets(),
          }),
    destroyClaim: (claim, label) => host.destroyOrphanSandbox(claim, label),
    revokeSession: (sessionId) => repos.revokeSession(sessionId),
    graceMs: config.sweep.graceMs,
    maxActions: config.sweep.maxActions,
  });
  running.sweeper = sweeper;
  sweeper.start(config.sweep.intervalMs);

  // Only the owner consumes the inbox. Rows that arrived while no orchestrator ran are waiting.
  const inbox = new InboxLoop(pool, (event, session) => service.apply(event, session));
  running.inbox = inbox;
  inbox.start();
}

main().catch((error: unknown) => {
  log("fatal", { message: errorMessage(error) });
  process.exit(1);
});
