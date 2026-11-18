import { readFile } from "node:fs/promises";
import {
  applyMigrations,
  PROBE_SHARD,
  startShardStatus,
  observeShardRuntime,
  conversationsWithExecInFlight,
  createPool,
  errorMessage,
  listSessionRefs,
  parseBindingKey,
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
import { McpAccess } from "./mcp-access.js";
import { HostRuleReconciler } from "./onecli-host-rules.js";
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
import { EgressPrincipals } from "./egress.js";
import { warmPoolFor } from "./warm-pool.js";
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
  const skills = new SkillLibrary(pool, config.shard);
  // The egress proxy (ADRs 0036, 0037): principals, the proxy environment of every session and, for repo sessions,
  // the OneCLI binding. Off without PI_EGRESS_PROXY_URL. The binding key is read once; a missing or malformed file
  // is fatal when the proxy is on, because a repo session would otherwise run without its credential.
  const bindingKey =
    config.egressProxyUrl === undefined || config.egressBindingKeyFile === undefined
      ? undefined
      : parseBindingKey(await readFile(config.egressBindingKeyFile, "utf8"));
  const egress =
    config.egressProxyUrl === undefined
      ? undefined
      : new EgressPrincipals({
          pool,
          proxyUrl: config.egressProxyUrl,
          bindingKey,
          master: () => {
            const master = process.env[ENV.masterKey];
            if (master === undefined || master === "")
              throw new Error(`${ENV.masterKey} is not set`);
            return master;
          },
        });
  const repos = new RepoAccess({
    pool,
    onecli,
    repoAllowed: (repo) => repoAllowed(repo, settings.repoAllowlist()),
    githubAppDir: config.repos.githubAppDir,
    gateway: config.onecli.gateway,
    caFile: config.onecli.caFile,
    fetch: callApi,
    namePrefix: config.repos.namePrefix,
    egress,
  });
  // The OneCLI identity of credentialed MCP calls: one agent per session, grants from its profile (ADR 0040, issue #42).
  const mcpAccess = new McpAccess({
    onecli,
    catalog: () => mcpCatalog.get(),
    sessionOf: (conversationId) => sessionByConversation(pool, config.shard, conversationId),
    gateway: config.onecli.gateway,
    caFile: config.onecli.caFile,
    noProxy: config.onecli.noProxy,
    namePrefix: config.repos.namePrefix,
  });
  running.mcpAccess = mcpAccess;
  const hooks: SandboxHooks = {
    // The session's size picks its pool; a session from before sizes keeps the unsized one.
    // Its network mode picks the pool of that size (ADR 0038); a session from before sizes and modes keeps `pi-env-pool`.
    warmPoolOf: async (conversationId) => {
      const session = await sessionByConversation(pool, config.shard, conversationId);
      if (session === undefined) return undefined;
      return warmPoolFor(config.warmPool, session.sandboxSize, session.networkMode, session.sandboxFlavour);
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
      try {
        const id = conversationOfName(config.shard, claimName);
        const direct =
          id === undefined ? undefined : await sessionByConversation(pool, config.shard, id);
        // The counter of ADR 0038 (docs/metrics.md): one line per attach of a sandbox with the open internet, no rules, no audit.
        if (direct?.networkMode === "direct") {
          log("direct-egress-sandbox", { level: "warn", session: direct.id, claim: claimName });
        }
      } catch {
        // A metric must never fail the attach.
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
    // A repo session's env comes from RepoAccess (the egress proxy's with the proxy on, the OneCLI gateway's without);
    // every other session gets the proxy's, or nothing.
    shellEnv: async (conversationId) => {
      const session = await sessionByConversation(pool, config.shard, conversationId);
      if (session === undefined) return undefined;
      if (session.repo !== null) return repos.shellEnv(session, conversationId);
      return egress?.shellEnv(session);
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
      mcpIdentity: mcpAccess,
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
    mcpAccess,
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
    revokeSession: async (sessionId) => {
      await repos.revokeSession(sessionId);
      await mcpAccess.revokeSession(sessionId);
    },
    listEgressPrincipals: egress === undefined ? undefined : () => egress.live(),
    revokeEgress: egress === undefined ? undefined : (sessionId) => egress.revoke(sessionId),
    graceMs: config.sweep.graceMs,
    maxActions: config.sweep.maxActions,
    namePrefix: config.repos.namePrefix,
  });
  running.sweeper = sweeper;
  sweeper.start(config.sweep.intervalMs);

  // The OneCLI host rules follow the egress rules (ADR 0040): a catalog PUT or a rule write reaches the gateway within a
  // pass, and the MCP servers retry their discovery as soon as the pass is done. Every shard runs one; a lock lets one pass at
  // a time write. Temporary here: the OneCLI admin key moves out of the orchestrator with #65, and so does this.
  if (onecli !== undefined && config.repos.reconcileHostRules) {
    const hostRules = new HostRuleReconciler({
      pool,
      onecli,
      onChanged: () => host.nudgeMcp(),
    });
    running.hostRules = hostRules;
    void hostRules.start();
    // A catalog change: the discovery agent of a server that left is removed, and once a pass has run (the derived rules are
    // in the same transaction as the catalog row) the servers retry their discovery without waiting for their backoff.
    mcpCatalog.subscribe((servers) => {
      void mcpAccess.reconcileDiscovery(servers).catch((error: unknown) => {
        log("mcp-discovery-agents-failed", { message: errorMessage(error) });
      });
      void hostRules.request().then(() => host.nudgeMcp());
    });
  } else {
    mcpCatalog.subscribe((servers) => {
      void mcpAccess.reconcileDiscovery(servers).catch((error: unknown) => {
        log("mcp-discovery-agents-failed", { message: errorMessage(error) });
      });
    });
  }

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
