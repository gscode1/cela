import { loadDatabaseTls, loadModelPolicy } from "@cela/session-core";
import type { DatabaseTls, ModelPolicy } from "@cela/session-core";
import { memoryLimitBytes, resolveBridgeCap } from "./bridge-cap.js";
import type { BridgeCapSource } from "./bridge-cap.js";
import { GITHUB_APP_DIR } from "./github-app.js";
import type { OneCliCallPolicy } from "./onecli-admin.js";
import { DEFAULT_ONECLI_NAME_PREFIX, validateNamePrefix } from "./onecli-names.js";
import { bypassesProxy, parseNoProxy, PLACEHOLDER_API_KEY, Redacted } from "./onecli.js";
import { CUSTOM_PROVIDERS_ENV, parseCustomProviders } from "./custom-providers.js";
import type { CustomProvider } from "./custom-providers.js";

/** Providers served by the in-process scripted model: no network, no OneCLI. */
const LOCAL_PROVIDERS = new Set(["scripted", "faux"]);

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/** The Postgres schema of a shard: the configured one for shard 0 (today's name), `<schema>_s<k>` for the others. */
export function shardSchema(base: string, shard: number): string {
  if (!SCHEMA_NAME.test(base)) throw new Error("PI_DURABLE_SCHEMA must match ^[a-z_][a-z0-9_]*$");
  if (!Number.isInteger(shard) || shard < 0)
    throw new Error("PI_ORCH_SHARD must be an integer of 0 or more");
  const name = shard === 0 ? base : `${base}_s${String(shard)}`;
  if (name.length > 63) throw new Error("the shard schema name is longer than 63 characters");
  return name;
}

/** Environment contract of the orchestrator. Secrets (database URL, sandboxd token, API tokens) are env-only. */
export interface OrchestratorConfig {
  databaseUrl: string;
  /** TLS towards Postgres (`PI_DURABLE_DATABASE_TLS_*`); undefined leaves the URI's own `sslmode` alone. */
  databaseTls: DatabaseTls | undefined;
  /** Dedicated schema holding the adapter's tables (created at start). Also the scope of the ownership lock. */
  schema: string;
  /** Which shard this orchestrator is; it owns the schema of that shard and the sessions assigned to it (ADR 0017). */
  shard: number;
  namespace: string;
  /**
   * The unsized SandboxWarmPool (`PI_ORCH_WARMPOOL`): what a session without a size references, and the prefix of the
   * sized pools (`<warmPool>-<size>`, docs/decisions/0030-sandbox-sizes.md).
   */
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
  /**
   * Operator-defined OpenAI-compatible providers (`PI_CUSTOM_MODEL_PROVIDERS`, the chart's `models.customProviders`; ADR
   * 0056). Identical on every shard; a direct provider needs no OneCLI token.
   */
  customProviders: readonly CustomProvider[];
  /** Model turns (assistant responses) one session may use in total; the first spend limit. */
  turnBudget: number;
  /** Sandbox idle handling. Both are in milliseconds; see docs/decisions/0004-idle-suspend.md. */
  sandbox: {
    /** An env with no call for this long is closed (its bridge process stops); the next tool call reopens it. */
    idleEvictMs: number;
    /** A sandbox idle this long is suspended (Pod deleted, PVC kept) and resumed by the next tool call. 0 = never. */
    idleSuspendMs: number;
    /**
     * Most envs open or opening at once; `Infinity` for no cap. Each costs a relay process and its broker state, so
     * this is what keeps the orchestrator under its memory limit. Derived from that limit unless set; see
     * docs/decisions/0018-derived-bridge-cap.md.
     */
    maxOpenBridges: number;
    /** Where `maxOpenBridges` came from, and the memory limit it was derived from (undefined: none). Logged at start. */
    bridgeCap: { source: BridgeCapSource; memoryLimitBytes: number | undefined };
    /** How often the RSS of each open bridge is logged (`bridge-rss`, docs/metrics.md). 0 = never. */
    bridgeRssIntervalMs: number;
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
  /** Where model and MCP calls go. `token` is set when the environment has one; remote model providers need it. */
  onecli: {
    gateway: string;
    caFile: string;
    noProxy: readonly string[];
    token: Redacted | undefined;
    /** Account id inside the OpenAI Codex placeholder token. The gateway injects the real one; see `codexPlaceholderToken`. */
    codexAccountId: string;
  };
  /**
   * The egress proxy (`PI_EGRESS_PROXY_URL`, set by the chart with `egressProxy.enabled`; ADR 0036): where a plain
   * session's tool commands send their traffic. Undefined: no principals, no proxy environment.
   */
  egressProxyUrl: string | undefined;
  /**
   * File holding the key that seals the OneCLI tokens in `egress.bindings` (`PI_EGRESS_BINDING_KEY_FILE`, the Secret the
   * proxy mounts too; ADR 0037). Needed for repo sessions behind the proxy; undefined refuses them.
   */
  egressBindingKeyFile: string | undefined;
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
    /** Per-call bounds on the OneCLI management API (PI_ONECLI_TIMEOUT_SECONDS, _RETRIES, _BACKOFF_MS). */
    onecliCalls: OneCliCallPolicy;
    /**
     * Prefix of this orchestrator's OneCLI agent and secret names (`PI_ONECLI_NAME_PREFIX`). Stacks that share a OneCLI
     * workspace need different ones, or each one's orphan sweep revokes the other's agents (ADR 0013).
     */
    namePrefix: string;
    /**
     * `PI_ONECLI_HOST_RULES=reconcile`: the orchestrator keeps OneCLI's host rules in step with the egress rules
     * (docs/decisions/0040-mcp-egress-flow.md). Off by default: it writes to the gateway's org rules, which an operator may
     * manage by script (docs/onecli-host-rules.md). The chart turns it on with the egress proxy.
     */
    reconcileHostRules: boolean;
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
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** Node clamps a timer delay above 2^31-1 ms to 1 ms, which would turn a long interval into a busy loop. */
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** A non-negative whole number of seconds from the environment, as milliseconds. */
function count(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = Number(env[name] ?? String(fallback));
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new Error(`${name} must be a whole number from 0 to ${String(max)}`);
  return value;
}

function seconds(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name] ?? String(fallback));
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a whole number of seconds, 0 or more`);
  if (value > MAX_TIMER_SECONDS)
    throw new Error(`${name} must be at most ${String(MAX_TIMER_SECONDS)} seconds (about 24 days)`);
  return value * 1000;
}

/**
 * `readMemoryLimit` lets tests pick the container limit, including "none". It is a function rather than a
 * `number | undefined` parameter because a default parameter cannot tell an explicit "no limit" from an omitted one.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readMemoryLimit: () => number | undefined = () => memoryLimitBytes(process.constrainedMemory()),
): OrchestratorConfig {
  const memoryLimit = readMemoryLimit();
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
  const bridgeCap = resolveBridgeCap(env.PI_MAX_OPEN_BRIDGES, memoryLimit);
  const maxActions = Number(env.PI_SWEEP_MAX_ACTIONS ?? "10");
  if (!Number.isInteger(maxActions) || maxActions < 1)
    throw new Error("PI_SWEEP_MAX_ACTIONS must be an integer of 1 or more");
  const shard = Number(env.PI_ORCH_SHARD ?? "0");
  const models = loadModelPolicy(env);
  const customProviders = parseCustomProviders(env[CUSTOM_PROVIDERS_ENV]);
  // A direct provider has no credential and does not use the gateway, so it needs no token.
  const local = new Set([
    ...LOCAL_PROVIDERS,
    ...customProviders.filter((p) => p.via === "direct").map((p) => p.id),
  ]);
  const remote = models.allowed.find((choice) => !local.has(choice.provider));
  const token = env.ONECLI_AGENT_TOKEN;
  if (remote !== undefined && !token) {
    throw new Error(`ONECLI_AGENT_TOKEN is required for model provider ${remote.provider}`);
  }
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const namespace = required("PI_ORCH_NAMESPACE");
  const warmPool = required("PI_ORCH_WARMPOOL");
  const gateway = required("PI_ONECLI_GATEWAY");
  const onecliApi = required("PI_ONECLI_API");
  const database = new URL(databaseUrl);
  const databaseHost =
    database.searchParams.get("host") || database.hostname || env.PGHOST || "localhost";
  const noProxy = [
    ...DEFAULT_NO_PROXY,
    databaseHost,
    new URL(onecliApi).hostname,
    ...parseNoProxy(env.NO_PROXY),
  ];
  for (const provider of customProviders) {
    // A host in NO_PROXY is called without the gateway, so no secret would be injected and the call would skip OneCLI's
    // rules: such a provider must say `via: direct` (chart egress rule, keyless), not hide behind `onecli`.
    if (provider.via === "onecli" && bypassesProxy(new URL(provider.baseUrl), noProxy))
      throw new Error(
        `custom provider ${provider.id}: its host is in NO_PROXY and would skip the OneCLI gateway; use via: direct (keyless) or another host`,
      );
  }
  return {
    databaseUrl,
    databaseTls: loadDatabaseTls(env),
    schema: shardSchema(env.PI_DURABLE_SCHEMA ?? "public", shard),
    shard,
    namespace,
    warmPool,
    port,
    instance: env.POD_NAME ?? `orchestrator-${String(process.pid)}`,
    apiTokens,
    control: env.PI_ORCH_CONTROL === "1",
    testFaults: env.PI_ORCH_TEST_FAULTS === "1",
    models,
    customProviders,
    turnBudget,
    sandbox: {
      idleEvictMs,
      idleSuspendMs,
      maxOpenBridges: bridgeCap.max,
      bridgeCap: { source: bridgeCap.source, memoryLimitBytes: memoryLimit },
      bridgeRssIntervalMs: seconds(env, "PI_BRIDGE_RSS_INTERVAL_SECONDS", 60),
    },
    sweep: {
      intervalMs: seconds(env, "PI_SWEEP_INTERVAL_SECONDS", 300),
      graceMs: seconds(env, "PI_SWEEP_GRACE_SECONDS", 600),
      maxActions,
    },
    onecli: {
      gateway,
      caFile: env.PI_ONECLI_CA_FILE ?? "/etc/onecli/ca.pem",
      noProxy,
      token: token ? new Redacted(token) : undefined,
      codexAccountId: env.PI_CODEX_ACCOUNT_ID ?? PLACEHOLDER_API_KEY,
    },
    egressProxyUrl: egressProxyUrl(env.PI_EGRESS_PROXY_URL),
    egressBindingKeyFile: env.PI_EGRESS_BINDING_KEY_FILE?.trim() || undefined,
    repos: {
      onecliApi,
      onecliApiKey: env.ONECLI_API_KEY ? new Redacted(env.ONECLI_API_KEY) : undefined,
      githubAppDir: env.PI_GITHUB_APP_DIR ?? GITHUB_APP_DIR,
      onecliCalls: {
        timeoutMs: Math.max(1_000, seconds(env, "PI_ONECLI_TIMEOUT_SECONDS", 15)),
        retries: count(env, "PI_ONECLI_RETRIES", 3, 10),
        backoffMs: count(env, "PI_ONECLI_BACKOFF_MS", 500, 60_000),
        maxBackoffMs: 5_000,
      },
      namePrefix: validateNamePrefix(env.PI_ONECLI_NAME_PREFIX ?? DEFAULT_ONECLI_NAME_PREFIX),
      reconcileHostRules: hostRulesMode(env.PI_ONECLI_HOST_RULES),
    },
  };
}

function hostRulesMode(value: string | undefined): boolean {
  const mode = value?.trim() ?? "";
  if (mode === "" || mode === "off") return false;
  if (mode === "reconcile") return true;
  throw new Error("PI_ONECLI_HOST_RULES must be reconcile or off");
}

/** `http://host:port` of the proxy Service, without credentials (the token is added per session); unset: undefined. */
function egressProxyUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (text === undefined || text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("PI_EGRESS_PROXY_URL is not a URL");
  }
  if (url.protocol !== "http:" || url.hostname === "" || url.username !== "" || url.password !== "")
    throw new Error("PI_EGRESS_PROXY_URL must be http://host:port with no credentials");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    throw new Error("PI_EGRESS_PROXY_URL must be http://host:port with no path");
  return `http://${url.host}`;
}
