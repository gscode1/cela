import {
  applyMigrations,
  PROBE_SHARD,
  startShardStatus,
  observeShardRuntime,
  conversationsWithExecInFlight,
  createPool,
  errorMessage,
  listSessionRefs,
  sessionByConversation,
  setExecInFlight,
  McpCatalogCache,
  SettingsCache,
  settingsFromEnv,
  tokenAuthenticator,
} from "@pi-durable-k8s/session-core";
import { bridgeCapFields } from "./bridge-cap.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./github-app.js";
import { OneCliAdmin } from "./onecli-admin.js";
import { modelCatalog, providerCredentials } from "./providers.js";
import { RepoAccess } from "./repo-access.js";
import type { SandboxHooks } from "./sandboxes.js";
import { liveConversationProfiles, publishAndCheckProfiles } from "./capabilities.js";
import { Host } from "./host.js";
import { createOrchestratorServer } from "./http.js";
import type { Lifecycle } from "./http.js";
import { INBOX_POOL_SIZE, InboxLoop } from "./inbox.js";
import { checkRuntime } from "./runtime.js";
import { clusterProbeIo } from "./netprobe-cluster.js";
import { deleteProbePods } from "./netprobe-kube.js";
import { NetworkProbeLoop, runNetworkProbe } from "./netprobe.js";
import { observedRuntime, listClaims, listPvcs } from "./kube.js";
import { log } from "./log.js";
import { SessionService } from "./sessions.js";
import { materializeSkills, SkillLibrary } from "./skills.js";
import { createShutdown } from "./shutdown.js";
import type { Running } from "./shutdown.js";
import { openStorageWhenFree } from "./storage.js";
import { OrphanSweeper } from "./sweeper.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const runtime = await checkRuntime(config.namespace, config.warmPool);
  const { maxOpenBridges, bridgeCap } = config.sandbox;
  log("bridge-cap", bridgeCapFields(maxOpenBridges, bridgeCap.source, bridgeCap.memoryLimitBytes));
  const lifecycle: Lifecycle = { state: "waiting-for-lock", instance: config.instance };
  // A second, independent connection pool for the inbox and the owner check: the Pi Durable adapter pins its
  // own connection and holds the ownership lock on it, and neither may share it.
  const pool = createPool(
    config.databaseUrl,
    `${config.instance}-inbox`,
    INBOX_POOL_SIZE,
    config.databaseTls,
  );
  const server = createOrchestratorServer({
    lifecycle,
    authenticate: tokenAuthenticator(config.apiTokens),
    pool,
    shard: config.shard,
    control: config.control,
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log("listening", { instance: config.instance, port: config.port });

  const running: Running = {};
  const stop = new AbortController();
  const shuttingDown = (): boolean => stop.signal.aborted;
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

  // Settings live in Postgres and ingest seeds them; until the row exists (or if it cannot be read) the environment's
  // values apply. The orchestrator reads only the turn budget from them: a session's model comes from its row.
  const settings = new SettingsCache(pool, { fallback: settingsFromEnv(process.env), log });
  running.settings = settings;
  await settings.start();

  // The MCP catalog, read the same way. Empty (MCP off) until the table says otherwise; a change installs or removes
  // the servers' extensions at runtime.
  const mcpCatalog = new McpCatalogCache(pool, { log });
  running.mcpCatalog = mcpCatalog;
  await mcpCatalog.start();

  const storage = await openStorageWhenFree(config, stop.signal);
  await startShardStatus(pool, config.shard, runtime);
  log("network-policy-unknown", {
    level: "warn",
    shard: config.shard,
    networkPolicy: "unknown",
    message: "Network isolation has not been verified",
  });
  log("lock-acquired", { instance: config.instance });
  // The isolation probe never gates anything: the orchestrator serves sessions whatever it finds (docs/network-policy.md).
  if (config.shard === PROBE_SHARD) {
    const io = clusterProbeIo(config, runtime, process.env);
    const probe = new NetworkProbeLoop(pool, config.shard, () => runNetworkProbe(io));
    running.netProbe = probe;
    await deleteProbePods(config.namespace).catch((error: unknown) => {
      log("netprobe-cleanup-failed", { message: errorMessage(error) });
    });
    probe.start(5_000);
  }
  const sessionKeyOf = async (conversationId: number): Promise<string> => {
    const session = await sessionByConversation(pool, config.shard, conversationId);
    // Conversations the inbox does not know are the test-only /control sessions.
    return session?.id ?? `control-${String(conversationId)}`;
  };
  // Repo workspaces (Phase 4c). Plain sessions never touch OneCLI's management API or GitHub through this.
  const callApi: FetchLike = (url, init) => fetch(url, init);
  const onecli =
    config.repos.onecliApiKey === undefined
      ? undefined
      : new OneCliAdmin(
          config.repos.onecliApi,
          config.repos.onecliApiKey,
          callApi,
          config.repos.onecliCalls,
        );
  const repos = new RepoAccess({
    pool,
    onecli,
    githubAppDir: config.repos.githubAppDir,
    gateway: config.onecli.gateway,
    caFile: config.onecli.caFile,
    fetch: callApi,
    namePrefix: config.repos.namePrefix,
  });
  const skills = new SkillLibrary(pool, config.shard);
  const hooks: SandboxHooks = {
    // The session's size picks its pool; a session from before sizes keeps the unsized one.
    warmPoolOf: async (conversationId) => {
      const size = (await sessionByConversation(pool, config.shard, conversationId))?.sandboxSize;
      return size === null || size === undefined ? undefined : `${config.warmPool}-${size}`;
    },
    // Status only: a failed read or write must never fail the attach, and with it the session's tool call.
    attached: async (claimName) => {
      try {
        await observeShardRuntime(
          pool,
          config.shard,
          await observedRuntime(config.namespace, claimName),
        );
      } catch (error) {
        log("runtime-observe-failed", { claim: claimName, error: errorMessage(error) });
      }
    },
    shellEnv: async (conversationId) => {
      const session = await sessionByConversation(pool, config.shard, conversationId);
      return session === undefined ? undefined : repos.shellEnv(session, conversationId);
    },
    beforeUse: (conversationId) => repos.beforeUse(conversationId),
    envStale: (conversationId) => repos.envStale(conversationId),
    execInFlight: (conversationId, inFlight) =>
      setExecInFlight(pool, config.shard, conversationId, inFlight),
    // Postgres is the source of truth for a session's skills; the workspace holds a copy, written at every attach.
    prepareEnv: async (conversationId, env) => {
      await materializeSkills(env, await skills.bundlesFor(conversationId));
    },
  };
  // Sandboxes that had a command running when the previous process died: Host.open recycles their Pods before Pi
  // Durable resumes (docs/decisions/0003-recycle-pod-on-interrupt.md).
  const recycleAtStart = await conversationsWithExecInFlight(pool, config.shard);
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
    {
      catalog: mcpCatalog,
      conversationProfiles: () => liveConversationProfiles(pool, config.shard),
    },
  );
  // Visible to the signal handler before Host.open settles, so a shutdown in that window still closes the host.
  running.opening = opening;
  const host = await opening;
  running.host = host;
  if (shuttingDown()) return;
  // Before the first input: ingest validates profile writes against what is installed here.
  // Also the model catalog and, from OneCLI's secrets, a credential hint per provider; refreshed at start only.
  await publishAndCheckProfiles(
    pool,
    {
      ...host.capabilities(),
      models: modelCatalog(host.models),
      modelProviders: await providerCredentials(
        host.models,
        config,
        onecli?.listSecrets.bind(onecli),
      ),
    },
    config.instance,
  );
  const service = new SessionService(pool, host, {
    shard: config.shard,
    testFaults: config.testFaults,
    defaultModel: config.models.default,
    turnBudget: () => settings.turnBudget(),
    tokenBudget: () => settings.tokenBudget(),
    repos,
    skills,
    timings: host.timings,
  });
  running.service = service;
  // Not fatal: a failed scan only means a run that died unseen is noticed at its next input.
  await service.recoverWatches().catch((error: unknown) => {
    log("run-watch-recover-failed", { message: errorMessage(error) });
  });
  if (shuttingDown()) return; // shutdown began during recovery: do not start the sweeper and inbox after it
  lifecycle.host = host;
  lifecycle.service = service;
  lifecycle.state = "owner";
  log("owner", { instance: config.instance });

  // Orphan sweep (docs/decisions/0002-orphan-sweep.md): only the owner runs it, like the inbox.
  const sweeper = new OrphanSweeper({
    shard: config.shard,
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
    namePrefix: config.repos.namePrefix,
  });
  running.sweeper = sweeper;
  sweeper.start(config.sweep.intervalMs);

  // Only the owner consumes the inbox. Rows that arrived while no orchestrator ran are waiting.
  const inbox = new InboxLoop(
    pool,
    config.shard,
    (event, session) => service.apply(event, session),
    (event, session) => service.prepare(event, session),
  );
  running.inbox = inbox;
  inbox.start();
}

main().catch((error: unknown) => {
  log("fatal", { message: errorMessage(error) });
  process.exit(1);
});
