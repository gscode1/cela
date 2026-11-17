import { adminJson, adminRequest } from "@/lib/api/raw";

export type NetworkPolicyState =
  "unknown" | "running" | "enforced" | "not-enforced" | "inconclusive";

/** One row of `GET /admin/status` (docs/session-api.md, "Isolation status"). */
export interface ShardStatus {
  shard: number;
  configuredRuntime: string;
  /** `null`: no sandbox Pod observed yet. `""`: observed, and the node default runtime applies. */
  observedRuntime: string | null;
  networkPolicy: NetworkPolicyState;
  networkPolicyCheckedAt: string | null;
  networkPolicyDetail: { state: string; reason: string } | null;
  updatedAt: string;
}

export interface StatusReport {
  shards: ShardStatus[];
  networkPolicy: { state: NetworkPolicyState; checkedAt: string | null } | null;
}

export function getStatus(token: string, signal?: AbortSignal): Promise<StatusReport> {
  return adminJson<StatusReport>(token, "/admin/status", signal ? { signal } : {});
}

export interface ProbeAnswer {
  requested: boolean;
  state: string;
}

/** Asks the first shard to run the isolation probe again (`202`; `503` before shard 0 has published). */
export async function requestProbe(token: string): Promise<ProbeAnswer> {
  const res = await adminRequest(token, "/admin/status/probe", { method: "POST" });
  return (await res.json()) as ProbeAnswer;
}

/** A runtime for a sentence: the node default has no name, and gVisor has a capital V. */
export function runtimeName(value: string): string {
  if (value === "") return "the node default runtime";
  return /^(gvisor|runsc)$/i.test(value) ? "gVisor" : value;
}

/** The Runtime cell: the value, and only when it differs from the configured one, both. `null` and `""` differ. */
export function runtimeText(shard: Pick<ShardStatus, "configuredRuntime" | "observedRuntime">): {
  text: string;
  mismatch: boolean;
} {
  const { configuredRuntime, observedRuntime } = shard;
  const plain = (value: string): string => (value === "" ? "node default" : value);
  if (observedRuntime === null) return { text: "not observed yet", mismatch: false };
  if (observedRuntime !== configuredRuntime)
    return {
      text: `configured ${plain(configuredRuntime)}, observed ${plain(observedRuntime)}`,
      mismatch: true,
    };
  return { text: plain(observedRuntime), mismatch: false };
}

export const POLICY_TEXT: Readonly<Record<NetworkPolicyState, string>> = {
  enforced: "enforced",
  "not-enforced": "not enforced",
  unknown: "not checked yet",
  running: "checking",
  inconclusive: "inconclusive",
};

export interface IsolationSummary {
  /** Every shard enforces the network policy and runs the runtime it is configured with. */
  healthy: boolean;
  /** One line per problem, naming the shard when there is more than one. */
  problems: string[];
  /** Normal states worth a muted line: no sandbox has started yet, so the runtime is not confirmed. */
  notes: string[];
  /** A probe is running: not a problem, but not healthy yet either. */
  checking: boolean;
  /** The runtimes the sandboxes run under, for the healthy sentence. */
  runtimes: string[];
}

export function summarizeIsolation(shards: readonly ShardStatus[]): IsolationSummary {
  const problems: string[] = [];
  const notes: string[] = [];
  const several = shards.length > 1;
  for (const shard of shards) {
    const who = several ? `Shard ${String(shard.shard)}: ` : "";
    const runtime = runtimeText(shard);
    if (shard.observedRuntime === null)
      notes.push(
        `${who}${several ? "n" : "N"}o sandbox has started since the last restart, so the runtime is not confirmed yet.`,
      );
    else if (runtime.mismatch) problems.push(`${who}${runtime.text}.`);
    if (shard.networkPolicy === "not-enforced")
      problems.push(`${who}network isolation is not enforced.`);
    else if (shard.networkPolicy === "unknown")
      problems.push(`${who}network isolation has not been checked since the last start.`);
    else if (shard.networkPolicy === "inconclusive")
      problems.push(`${who}the network isolation check was inconclusive.`);
  }
  const checking = shards.some((shard) => shard.networkPolicy === "running");
  const runtimes = [
    ...new Set(
      shards.flatMap((shard) => (shard.observedRuntime === null ? [] : [shard.observedRuntime])),
    ),
  ];
  return {
    healthy: shards.length > 0 && problems.length === 0 && !checking,
    problems,
    notes,
    checking,
    runtimes,
  };
}

/** The "checked" time of a policy result is worth a word only when it is old. */
export const isStale = (iso: string, now: Date = new Date()): boolean =>
  now.getTime() - new Date(iso).getTime() > 86_400_000;
