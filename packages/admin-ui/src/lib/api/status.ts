import { adminJson, adminRequest } from "@/lib/api/raw";

export type NetworkPolicyState =
  "unknown" | "running" | "enforced" | "not-enforced" | "inconclusive";

/** One sandbox runtime of a shard (ADR 0064): `observed` is `null` until a session of that runtime attached. */
export interface RuntimeStatus {
  configured: string;
  observed: string | null;
  insecure: boolean;
}

/** One row of `GET /admin/status` (docs/session-api.md, "Isolation status"). */
export interface ShardStatus {
  shard: number;
  configuredRuntime: string;
  /** `null`: no sandbox Pod observed yet. `""`: observed, and the node default runtime applies. */
  observedRuntime: string | null;
  /** Every runtime of the shard, `default` and the named ones; absent from an older ingest. */
  runtimes?: Record<string, RuntimeStatus>;
  networkPolicy: NetworkPolicyState;
  networkPolicyCheckedAt: string | null;
  networkPolicyDetail: { state: string; reason: string } | null;
  /** A probe an admin asked for that shard 0 has not taken yet; null on the other rows. */
  probeRequestedAt: string | null;
  updatedAt: string;
}

export interface StatusReport {
  shards: ShardStatus[];
  /** The cluster-wide verdict: shard 0 probes, the policy is the same for every shard. `null` before any report. */
  networkPolicy: {
    state: NetworkPolicyState;
    checkedAt: string | null;
    detail?: { state: string; reason: string } | null;
    requestedAt: string | null;
  } | null;
  /** Live sessions in network mode `direct` (open internet, no rules, no audit); 0 unless the chart allows it. */
  directSessions?: number;
}

/**
 * A probe takes seconds to a minute; follow it while it runs, and while a request waits for shard 0 to take it (the
 * state is still the old verdict until then).
 */
export function statusPollInterval(shards: readonly ShardStatus[] | undefined): number | false {
  return shards?.some(
    (shard) => shard.networkPolicy === "running" || shard.probeRequestedAt !== null,
  ) === true
    ? 3_000
    : false;
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

/** The named runtimes of a shard (not `default`, whose values are the top-level fields), by name. */
export function namedRuntimes(shard: Pick<ShardStatus, "runtimes">): [string, RuntimeStatus][] {
  return Object.entries(shard.runtimes ?? {}).filter(([name]) => name !== "default");
}

/** `runtimeText` for one entry of `ShardStatus.runtimes`. */
export const runtimeStatusText = (
  status: Pick<RuntimeStatus, "configured" | "observed">,
): ReturnType<typeof runtimeText> =>
  runtimeText({ configuredRuntime: status.configured, observedRuntime: status.observed });
