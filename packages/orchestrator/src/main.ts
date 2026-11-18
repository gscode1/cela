import {
  applyMigrations,
  PROBE_SHARD,
  startShardStatus,
  observeShardRuntime,
  conversationsWithExecInFlight,
  createPool,
  errorMessage,
  listSessionRefs,
  livePrincipalSessions,
  publishModelProviders,
  repoAllowed,
  sessionByConversation,
  setExecInFlight,
  McpCatalogCache,
  SettingsCache,
  settingsFromEnv,
  tokenAuthenticator,
} from "@pi-durable-k8s/session-core";
import { ENV } from "@pi-durable-k8s/sandbox-env";
import { bridgeCapFields } from "./bridge-cap.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./github-app.js";
import { OneCliAdmin } from "./onecli-admin.js";
import { modelCatalog, providerCredentials } from "./providers.js";
import { RepoAccess } from "./repo-access.js";
import type { SandboxHooks } from "./sandboxes.js";
import {
  liveConversationProfiles,
  ModelCredentialsLoop,
  publishAndCheckProfiles,
} from "./capabilities.js";
import { Host } from "./host.js";
import { createOrchestratorServer } from "./http.js";
import type { Lifecycle } from "./http.js";
import { INBOX_POOL_SIZE, InboxLoop } from "./inbox.js";
import { checkRuntime } from "./runtime.js";
import { clusterProbeIo } from "./netprobe-cluster.js";
import { deleteProbePods } from "./netprobe-kube.js";
import { NetworkProbeLoop, runNetworkProbe } from "./netprobe.js";
import { observedPod, listClaims, listPvcs } from "./kube.js";
import { claimNameFor, conversationOfName } from "./lifecycle.js";
import { EgressPrincipals, usesEgressProxy } from "./egress.js";
import { log } from "./log.js";
import { SessionService } from "./sessions.js";
import { materializeSkills, SkillLibrary } from "./skills.js";
import { createShutdown } from "./shutdown.js";
import type { Running } from "./shutdown.js";
import { openStorageWhenFree } from "./storage.js";
import { OrphanSweeper } from "./sweeper.js";

/** How often shard 0 re-reads OneCLI's secrets for the credential hint: one cheap listing (the sweep makes the same). */
const MODEL_CREDENTIALS_INTERVAL_MS = 30_000;

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
    repoAllowed: (repo) => repoAllowed(repo, settings.repoAllowlist()),
    githubAppDir: config.repos.githubAppDir,
    gateway: config.onecli.gateway,
    caFile: config.onecli.caFile,
    fetch: callApi,
    namePrefix: config.repos.namePrefix,
  });
  const skills = new SkillLibrary(pool, config.shard);
  // The egress proxy (ADR 0036): principals and the proxy environment of plain sessions. Off without PI_EGRESS_PROXY_URL.
  const egress =
    config.egressProxyUrl === undefined
      ? undefined
      : new EgressPrincipals({
          pool,
          proxyUrl: config.egressProxyUrl,
          master: () => {
            const master = process.env[ENV.masterKey];
            if (master === undefined || master === "")
              throw new Error(`${ENV.masterKey} is not set`);
            return master;
          },
        });
  const hooks: SandboxHooks = {
    // The session's size picks its pool; a session from before sizes keeps the unsized one.
    warmPoolOf: async (conversationId) => {
      const size = (await sessionByConversation(pool, config.shard, conversationId))?.sandboxSize;
      return size === null || size === undefined ? undefined : `${config.warmPool}-${size}`;
    },
    // Status only: a failed read or write must never fail the attach, and with it the session's tool call.
    attached: async (claimName) => {
      let pod: Awaited<ReturnType<typeof observedPod>> | undefined;
      try {
        pod = await observedPod(config.namespace, claimName);
        await observeShardRuntime(pool, config.shard, pod.runtime);
      } catch (error) {
        log("runtime-observe-failed", { claim: claimName, error: errorMessage(error) });
      }
      if (egress === undefined) return;
      // Records the Pod's address before the first command. A failure only means the proxy refuses this session's token
      // until the next attach or check: it never fails the attach.
      try {
        const conversationId = conversationOfName(config.shard, claimName);
        const session =
          conversationId === undefined
            ? undefined
            : await sessionByConversation(pool, config.shard, conversationId);
        if (session !== undefined) await egress.attached(session, pod?.podIp);
      } catch (error) {
        log("egress-principal-failed", { claim: claimName, error: errorMessage(error) });
      }
    },
    // A repo session keeps the OneCLI environment until slice 5; every other session gets the proxy's.
    shellEnv: async (conversationId) => {
      const session = await sessionByConversation(pool, config.shard, conversationId);
      if (session === undefined) return undefined;
      if (egress !== undefined && usesEgressProxy(session)) return egress.shellEnv(session);
      return repos.shellEnv(session, conversationId);
    },
    beforeUse: async (conversationId) => {
      await repos.beforeUse(conversationId);
      if (egress === undefined) return;
      try {
        const session = await sessionByConversation(pool, config.shard, conversationId);
        if (session === undefined) return;
        const claim = claimNameFor(config.shard, conversationId);
        await egress.beforeUse(
          session,
          async () => (await observedPod(config.namespace, claim)).podIp,
        );
      } catch (error) {
        log("egress-pod-ip-failed", { conversation: conversationId, error: errorMessage(error) });
      }
    },
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
  // Also the model catalog and, from OneCLI's secrets, a credential hint per provider (shard 0 refreshes the hint below).
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
  // A secret added to OneCLI shows in the console within a check, no restart (ADR 0025). One shard writes the shared row.
  if (onecli !== undefined && config.shard === PROBE_SHARD) {
    const credentials = new ModelCredentialsLoop({
      models: host.models,
      config,
      listSecrets: () => onecli.listSecrets(),
      publish: (providers) => publishModelProviders(pool, providers),
    });
    running.modelCredentials = credentials;
    credentials.start(MODEL_CREDENTIALS_INTERVAL_MS);
  }
  const service = new SessionService(pool, host, {
    shard: config.shard,
    testFaults: config.testFaults,
    defaultModel: config.models.default,
    turnBudget: () => settings.turnBudget(),
    tokenBudget: () => settings.tokenBudget(),
    repos,
    ...(egress === undefined ? {} : { egress }),
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
    listEgressPrincipals: egress === undefined ? undefined : () => livePrincipalSessions(pool),
    revokeEgress: egress === undefined ? undefined : (sessionId) => egress.revoke(sessionId),
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
