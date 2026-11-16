import { loadModelPolicy } from "@pi-durable-k8s/session-core";
import type { ModelPolicy } from "@pi-durable-k8s/session-core";
import { GITHUB_APP_DIR } from "./github-app.js";
import { parseNoProxy, PLACEHOLDER_API_KEY, Redacted } from "./onecli.js";

/** Providers served by the in-process scripted model: no network, no OneCLI. */
const LOCAL_PROVIDERS = new Set(["scripted", "faux"]);

/** Environment contract of the orchestrator. Secrets (database URL, sandboxd token, API tokens) are env-only. */
export interface OrchestratorConfig {
  databaseUrl: string;
  /** Dedicated schema holding the adapter's tables; it must exist. Also the scope of the ownership lock. */
  schema: string;
  namespace: string;
  /** SandboxWarmPool every session's claim references. */
  warmPool: string;
  port: number;
  /** Names this process in pg_stat_activity and logs. */
  instance: string;
  /** `owner:token` entries for the same bearer-token authentication as ingest. */
  apiTokens: string;
  /** Mount the test-only /control surface (Phase 3 scripted sessions). */
  control: boolean;
  /** Honour `payload.testFault` on inbox rows (test 4 kills the process between submit and mark). */
  testFaults: boolean;
  /** Default model and allowlist (`PI_MODEL_PROVIDER`, `PI_MODEL_ID`, `PI_MODEL_ALLOWLIST`, one ConfigMap). */
  models: ModelPolicy;
  /** Model turns (assistant responses) one session may use in total; the first spend limit. */
  turnBudget: number;
  /** Sandbox idle handling. Both are in milliseconds; see docs/decisions/0004-idle-suspend.md. */
  sandbox: {
    /** An env with no call for this long is closed (its bridge process stops); the next tool call reopens it. */
    idleEvictMs: number;
    /** A sandbox idle this long is suspended (Pod deleted, PVC kept) and resumed by the next tool call. 0 = never. */
    idleSuspendMs: number;
  };
  /** Periodic removal of resources whose session is deleted or unknown; see docs/decisions/0002-orphan-sweep.md. */
  sweep: {
    /** Time between runs. 0 turns the sweep off. */
    intervalMs: number;
    /** An object younger than this is never swept. */
    graceMs: number;
    /** Most actions per run. */
    maxActions: number;
  };
  /** Where model calls go. `token` is set only when some allowed provider needs the gateway. */
  onecli: {
    gateway: string;
    caFile: string;
    noProxy: readonly string[];
    token: Redacted | undefined;
    /** Account id inside the OpenAI Codex placeholder token. The gateway injects the real one; see `codexPlaceholderToken`. */
    codexAccountId: string;
  };
  /**
   * Optional repository workspaces (Phase 4c). Both secrets reach the orchestrator only: the OneCLI admin API key
   * from Secret `pi-onecli-admin` (env), the GitHub App key from Secret `pi-github-app` (mounted files).
   */
  repos: {
    /** Management API of OneCLI v2, `:10256`. The proxy (`onecli.gateway`) is a different port. */
    onecliApi: string;
    /** `ONECLI_API_KEY` (`oc_...`). Undefined: sessions that ask for a repo are refused. */
    onecliApiKey: Redacted | undefined;
    githubAppDir: string;
  };
}

/**
 * Hosts a model call must never be proxied to: the cluster, the Kubernetes API and Postgres. The gateway refuses
 * private targets anyway; this keeps them off it. The deployment also exports it as `NO_PROXY`, and an entry
 * of `NO_PROXY` in the environment adds to it.
 */
export const DEFAULT_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  ".svc",
  ".cluster.local",
  "kubernetes.default",
  "pi-pg-rw",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** A non-negative whole number of seconds from the environment, as milliseconds. */
function seconds(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name] ?? String(fallback));
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number of seconds, 0 or more`);
  return value * 1000;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): OrchestratorConfig {
  const databaseUrl = env.PI_DURABLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("PI_DURABLE_DATABASE_URL is required");
  const apiTokens = env.PI_API_TOKENS;
  if (!apiTokens) throw new Error("PI_API_TOKENS is required");
  const port = Number(env.PI_ORCH_PORT ?? "8081");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PI_ORCH_PORT is invalid");
  const turnBudget = Number(env.PI_SESSION_TURN_BUDGET ?? "100");
  if (!Number.isInteger(turnBudget) || turnBudget < 1)
    throw new Error("PI_SESSION_TURN_BUDGET must be an integer of 1 or more");
  const idleEvictMs = seconds(env, "PI_SANDBOX_IDLE_EVICT_SECONDS", 120);
  const idleSuspendMs = seconds(env, "PI_SANDBOX_IDLE_SUSPEND_SECONDS", 1800);
  // A sandbox is suspended only after its bridge is gone; suspending first would cut a bridge that is still open.
  if (idleSuspendMs > 0 && idleSuspendMs < idleEvictMs)
    throw new Error(
      "PI_SANDBOX_IDLE_SUSPEND_SECONDS must not be below PI_SANDBOX_IDLE_EVICT_SECONDS",
    );
  const maxActions = Number(env.PI_SWEEP_MAX_ACTIONS ?? "10");
  if (!Number.isInteger(maxActions) || maxActions < 1)
    throw new Error("PI_SWEEP_MAX_ACTIONS must be an integer of 1 or more");
  const models = loadModelPolicy(env);
  const remote = models.allowed.find((choice) => !LOCAL_PROVIDERS.has(choice.provider));
  const token = env.ONECLI_AGENT_TOKEN;
  if (remote !== undefined && !token) {
    throw new Error(`ONECLI_AGENT_TOKEN is required for model provider ${remote.provider}`);
  }
  return {
    databaseUrl,
    schema: env.PI_DURABLE_SCHEMA ?? "public",
    namespace: env.PI_ORCH_NAMESPACE ?? "pi-durable-poc",
    warmPool: env.PI_ORCH_WARMPOOL ?? "pi-env-pool",
    port,
    instance: env.POD_NAME ?? `orchestrator-${String(process.pid)}`,
    apiTokens,
    control: env.PI_ORCH_CONTROL === "1",
    testFaults: env.PI_ORCH_TEST_FAULTS === "1",
    models,
    turnBudget,
    sandbox: { idleEvictMs, idleSuspendMs },
    sweep: {
      intervalMs: seconds(env, "PI_SWEEP_INTERVAL_SECONDS", 300),
      graceMs: seconds(env, "PI_SWEEP_GRACE_SECONDS", 600),
      maxActions,
    },
    onecli: {
      gateway: env.PI_ONECLI_GATEWAY ?? "http://onecli.onecli:10255",
      caFile: env.PI_ONECLI_CA_FILE ?? "/etc/onecli/ca.pem",
      noProxy: [...DEFAULT_NO_PROXY, ...parseNoProxy(env.NO_PROXY)],
      token: token ? new Redacted(token) : undefined,
      codexAccountId: env.PI_CODEX_ACCOUNT_ID ?? PLACEHOLDER_API_KEY,
    },
    repos: {
      onecliApi: env.PI_ONECLI_API ?? "http://onecli.onecli:10256",
      onecliApiKey: env.ONECLI_API_KEY ? new Redacted(env.ONECLI_API_KEY) : undefined,
      githubAppDir: env.PI_GITHUB_APP_DIR ?? GITHUB_APP_DIR,
    },
  };
}
