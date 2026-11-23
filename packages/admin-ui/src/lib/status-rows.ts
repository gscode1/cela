import type { EgressStatus } from "@/lib/api/egress";
import type { McpCatalog, McpServer } from "@/lib/api/mcp";
import type { ModelCatalog } from "@/lib/api/models";
import type {
  NetworkModeCatalog,
  SandboxFlavourCatalog,
  SandboxSizeCatalog,
  ToolCatalog,
} from "@/lib/api/profiles";
import { namedRuntimes, runtimeName, runtimeStatusText, runtimeText } from "@/lib/api/status";
import type { NetworkPolicyState, ShardStatus, StatusReport } from "@/lib/api/status";

/** What a query has so far, without the query library: loading, failed with a message, or an answer. */
export type Source<T> =
  { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

export interface StatusInputs {
  status: Source<StatusReport>;
  egress: Source<EgressStatus>;
  models: Source<ModelCatalog>;
  mcp: Source<McpCatalog>;
  /** Left out where only the problems matter (the navigation dot). */
  deployment?: {
    networkModes: Source<NetworkModeCatalog>;
    flavours: Source<SandboxFlavourCatalog>;
    sizes: Source<SandboxSizeCatalog>;
    tools: Source<ToolCatalog>;
  };
}

/** `problem` is wrong now; `attention` is not verified or in motion; `info` is a fact, neither good nor bad. */
export type Level = "problem" | "attention" | "unknown" | "ok" | "info";

export type RowId =
  "runtime" | "network" | "direct" | "shards" | "egress" | "onecli" | "mcp" | "deployment";

export interface StatusRow {
  id: RowId;
  title: string;
  level: Level;
  sentence: string;
  /** A time that follows the sentence, with its label ("last report"). */
  when?: { label: string; iso: string };
  /** MCP servers to name as links after the sentence. */
  failing?: string[];
  /** The reader has no answer (loading or failed): nothing to show under Details. */
  unavailable?: true;
  /** A network isolation check is running or asked for. */
  checking?: boolean;
}

const RANK: Record<Level, number> = { problem: 0, attention: 1, unknown: 2, ok: 3, info: 4 };

const worst = (levels: readonly Level[]): Level =>
  levels.reduce<Level>((a, b) => (RANK[b] < RANK[a] ? b : a), "info");

const plural = (n: number, one: string, many: string = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The row for a source that has no answer: still loading, or failed. */
function pending(
  id: RowId,
  title: string,
  source: Exclude<Source<unknown>, { state: "ok" }>,
): StatusRow {
  return {
    id,
    title,
    level: "unknown",
    unavailable: true,
    sentence: source.state === "loading" ? "Loading…" : `Could not read: ${source.message}`,
  };
}

/**
 * The default runtime's row (the top-level fields), then the named runtimes of ADR 0064 on top: a class that differs from
 * the configured one is a problem, an insecure runtime needs attention, and the isolation probe only covers the default.
 */
function runtimeRow(source: Source<StatusReport>): StatusRow {
  const base = defaultRuntimeRow(source);
  if (source.state !== "ok") return base;
  const shards = source.data.shards;
  const several = shards.length > 1;
  const named = shards.flatMap((shard) =>
    namedRuntimes(shard).map(([name, status]) => ({ shard, name, status })),
  );
  if (named.length === 0) return base;
  const wrong = named.filter(({ status }) => runtimeStatusText(status).mismatch);
  const insecure = [...new Set(named.filter(({ status }) => status.insecure).map((n) => n.name))];
  const parts = [base.sentence];
  for (const { shard, name, status } of wrong) {
    parts.push(
      `${several ? `Shard ${String(shard.shard)}, runtime` : "Runtime"} ${name}: ${runtimeStatusText(status).text}.`,
    );
  }
  if (insecure.length > 0) parts.push(`Insecure runtimes (not gVisor): ${insecure.join(", ")}.`);
  parts.push("The isolation probe runs under the default runtime only.");
  return {
    ...base,
    level: worst([
      base.level === "info" ? "ok" : base.level,
      ...(wrong.length > 0 ? (["problem"] as const) : []),
      ...(insecure.length > 0 ? (["attention"] as const) : []),
    ]),
    sentence: parts.join(" "),
  };
}

function defaultRuntimeRow(source: Source<StatusReport>): StatusRow {
  if (source.state !== "ok") return pending("runtime", "Sandbox runtime", source);
  const shards = source.data.shards;
  const row = { id: "runtime", title: "Sandbox runtime" } as const;
  if (shards.length === 0)
    return { ...row, level: "attention", sentence: "No shard has reported yet." };
  const several = shards.length > 1;
  const who = (shard: ShardStatus): string => (several ? `shard ${String(shard.shard)}` : "");
  const mismatched = shards.filter((shard) => runtimeText(shard).mismatch);
  if (mismatched.length > 0)
    return {
      ...row,
      level: "problem",
      sentence: mismatched
        .map(
          (shard) =>
            `${several ? `Shard ${String(shard.shard)}: ` : ""}${runtimeText(shard).text}.`,
        )
        .join(" "),
    };
  const unobserved = shards.filter((shard) => shard.observedRuntime === null);
  if (unobserved.length === shards.length)
    return {
      ...row,
      level: "attention",
      sentence: "Not observed yet: no sandbox has started since the last restart.",
    };
  const names = [
    ...new Set(
      shards.flatMap((shard) =>
        shard.observedRuntime === null ? [] : [runtimeName(shard.observedRuntime)],
      ),
    ),
  ];
  const base = `Sandboxes run under ${names.join(" and ")}`;
  if (unobserved.length > 0)
    return {
      ...row,
      level: "attention",
      sentence: `${base}; not observed yet on ${unobserved.map(who).join(", ")}.`,
    };
  return { ...row, level: "ok", sentence: several ? `${base} on all shards.` : `${base}.` };
}

/** What the cluster-wide network policy verdict is, from the top-level field or, failing that, shard 0's row. */
export function networkPolicyOf(report: StatusReport): {
  state: NetworkPolicyState;
  checkedAt: string | null;
  reason: string | null;
  requested: boolean;
} {
  const top = report.networkPolicy;
  const first = report.shards[0];
  const state = top?.state ?? first?.networkPolicy ?? "unknown";
  const requested = (top?.requestedAt ?? first?.probeRequestedAt ?? null) !== null;
  return {
    state,
    checkedAt: top?.checkedAt ?? first?.networkPolicyCheckedAt ?? null,
    reason: top?.detail?.reason ?? first?.networkPolicyDetail?.reason ?? null,
    requested,
  };
}

function networkRow(source: Source<StatusReport>): StatusRow {
  if (source.state !== "ok") return pending("network", "Network isolation", source);
  const policy = networkPolicyOf(source.data);
  const row = { id: "network", title: "Network isolation" } as const;
  const checking = policy.state === "running" || policy.requested;
  if (checking) return { ...row, level: "attention", sentence: "Checking…", checking };
  switch (policy.state) {
    case "enforced":
      return {
        ...row,
        level: "ok",
        sentence: "Enforced.",
        ...(policy.checkedAt === null ? {} : { when: { label: "checked", iso: policy.checkedAt } }),
      };
    case "not-enforced":
      return {
        ...row,
        level: "problem",
        sentence: "Not enforced: sandboxes are not walled off from the network.",
        ...(policy.checkedAt === null ? {} : { when: { label: "checked", iso: policy.checkedAt } }),
      };
    case "inconclusive":
      return { ...row, level: "attention", sentence: "The last check was inconclusive." };
    default:
      return { ...row, level: "attention", sentence: "Not checked since the last start." };
  }
}

function directRow(source: Source<StatusReport>): StatusRow | undefined {
  if (source.state !== "ok") return undefined;
  const direct = source.data.directSessions ?? 0;
  if (direct <= 0) return undefined;
  return {
    id: "direct",
    title: "Direct sessions",
    level: "attention",
    sentence: `${plural(direct, "live session")} with open internet.`,
  };
}

function shardsRow(source: Source<StatusReport>): StatusRow {
  if (source.state !== "ok") return pending("shards", "Orchestrator shards", source);
  const shards = source.data.shards;
  const row = { id: "shards", title: "Orchestrator shards" } as const;
  if (shards.length === 0)
    return { ...row, level: "attention", sentence: "No shard has reported yet." };
  // The newest report: a report is a record of the last start and publish, not a heartbeat.
  const latest = shards.reduce((a, b) =>
    Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a,
  );
  return {
    ...row,
    level: "ok",
    sentence: `${plural(shards.length, "shard")} reported.`,
    when: { label: "last report", iso: latest.updatedAt },
  };
}

/** Whether a replica that says it serves holds the current rules. */
const inSync = (replica: EgressStatus["proxy"]["replicas"][number], revision: number): boolean =>
  replica.revision === revision;

function egressRow(source: Source<EgressStatus>): StatusRow {
  if (source.state !== "ok") return pending("egress", "Egress proxy", source);
  const { revision, invalid, proxy } = source.data;
  const row = { id: "egress", title: "Egress proxy" } as const;
  if (proxy.replicas.length === 0)
    return { ...row, level: "attention", sentence: proxy.note ?? "No reports yet." };
  const label = (replica: { name?: string }): string => replica.name ?? "proxy";
  const stale = proxy.replicas.filter((r) => r.state === "stale" || r.state === "silent");
  const starting = proxy.replicas.filter((r) => r.state === "starting");
  const serving = proxy.replicas.filter((r) => r.state === undefined || r.state === "serving");
  const behind = serving.filter((r) => !inSync(r, revision));
  const parts: string[] = [];
  const levels: Level[] = [];
  if (stale.length > 0) {
    parts.push(
      stale.map((r) => `${label(r)} is ${r.state === "silent" ? "silent" : "stale"}`).join(", "),
    );
    levels.push("problem");
  }
  if (starting.length > 0) {
    parts.push(`${starting.map(label).join(", ")} starting`);
    levels.push("attention");
  }
  if (behind.length > 0) {
    parts.push(`${behind.map(label).join(", ")} not at the current rules yet`);
    levels.push("attention");
  }
  if (serving.length > behind.length)
    parts.push(`${plural(serving.length - behind.length, "replica")} serving, in sync`);
  if (invalid > 0) {
    parts.push(`${plural(invalid, "stored row")} invalid and not evaluated`);
    levels.push("attention");
  }
  return {
    ...row,
    level: levels.length === 0 ? "ok" : worst(levels),
    sentence: `${parts.join("; ")}.`,
  };
}

/** Providers of the catalog whose credential is in OneCLI, in the order the API gives them. */
export const configuredProviders = (catalog: ModelCatalog): string[] =>
  catalog.providers.filter((p) => p.credential === "configured").map((p) => p.provider);

function onecliRow(models: Source<ModelCatalog>, mcp: Source<McpCatalog>): StatusRow {
  const row = { id: "onecli", title: "OneCLI" } as const;
  if (models.state !== "ok") return pending("onecli", "OneCLI", models);
  const catalog = models.data;
  const parts: string[] = [];
  let level: Level;
  if (catalog.credentials === "configured") {
    const names = configuredProviders(catalog);
    const missing = catalog.providers.filter((p) => p.credential === "missing");
    parts.push(
      names.length > 0
        ? `Model credentials configured for ${names.join(", ")}`
        : "Model credentials configured",
    );
    if (missing.length > 0) parts.push(`missing for ${missing.map((p) => p.provider).join(", ")}`);
    level = missing.length > 0 ? "attention" : "ok";
  } else if (catalog.credentials === "none-configured") {
    parts.push("No model credentials: OneCLI holds none");
    level = "problem";
  } else {
    parts.push(
      catalog.source === "none"
        ? "Model credentials not known: the orchestrator has not published its catalog"
        : "Model credentials could not be checked",
    );
    level = "unknown";
  }
  if (mcp.state === "ok") {
    const secrets = mcp.data.onecliSecrets;
    parts.push(
      secrets?.source === "orchestrator"
        ? `secret list known (${String(secrets.names.length)})`
        : "secret list unknown",
    );
  }
  const text = parts.join("; ");
  return { ...row, level, sentence: `${text}.` };
}

/** A server's state for the row, from what the orchestrator found at discovery (ADR 0044). */
export function mcpState(server: McpServer): "ready" | "failing" | "unknown" | "disabled" {
  if (!server.enabled) return "disabled";
  if (server.reachability === "ok") return "ready";
  if (server.reachability === "failing") return "failing";
  return "unknown";
}

function mcpRow(source: Source<McpCatalog>): StatusRow {
  if (source.state !== "ok") return pending("mcp", "MCP servers", source);
  const row = { id: "mcp", title: "MCP servers" } as const;
  const states = source.data.servers.map((server) => ({ server, state: mcpState(server) }));
  const failing = states.filter((s) => s.state === "failing").map((s) => s.server.name);
  const ready = states.filter((s) => s.state === "ready").length;
  const unknown = states.filter((s) => s.state === "unknown").length;
  const enabled = states.filter((s) => s.state !== "disabled").length;
  const invalid = source.data.invalid.length;
  if (enabled === 0 && invalid === 0)
    return { ...row, level: "info", sentence: "No MCP server is enabled." };
  const parts = [`${String(ready)} ready`, `${String(failing.length)} failing`];
  if (unknown > 0) parts.push(`${String(unknown)} not reported yet`);
  if (invalid > 0) parts.push(`${String(invalid)} invalid`);
  const level: Level =
    failing.length > 0 ? "problem" : invalid > 0 ? "attention" : unknown > 0 ? "unknown" : "ok";
  return { ...row, level, sentence: parts.join(", "), ...(failing.length > 0 ? { failing } : {}) };
}

function deploymentRow(deployment: NonNullable<StatusInputs["deployment"]>): StatusRow {
  const row = { id: "deployment", title: "Deployment" } as const;
  const { networkModes, flavours, sizes } = deployment;
  const failed = [networkModes, flavours, sizes, deployment.tools].find((s) => s.state === "error");
  if (failed?.state === "error")
    return {
      ...row,
      level: "unknown",
      unavailable: true,
      sentence: `Could not read: ${failed.message}`,
    };
  if (networkModes.state !== "ok" || flavours.state !== "ok" || sizes.state !== "ok")
    return { ...row, level: "unknown", unavailable: true, sentence: "Loading…" };
  return {
    ...row,
    level: "info",
    sentence: `Direct egress ${networkModes.data.directAllowed ? "allowed" : "not allowed"}, browser image ${
      flavours.data.browserEnabled ? "enabled" : "disabled"
    }, ${plural(sizes.data.sizes.length, "sandbox size")}.`,
  };
}

/** The page's rows, problems first; rows of equal level keep their order. */
export function statusRows(input: StatusInputs): StatusRow[] {
  const rows: StatusRow[] = [
    runtimeRow(input.status),
    networkRow(input.status),
    ...[directRow(input.status)].filter((row) => row !== undefined),
    shardsRow(input.status),
    egressRow(input.egress),
    onecliRow(input.models, input.mcp),
    mcpRow(input.mcp),
    ...(input.deployment === undefined ? [] : [deploymentRow(input.deployment)]),
  ];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => RANK[a.row.level] - RANK[b.row.level] || a.index - b.index)
    .map(({ row }) => row);
}

/** Whether anything is wrong now, for the navigation dot. */
export const hasProblem = (rows: readonly StatusRow[]): boolean =>
  rows.some((row) => row.level === "problem");
