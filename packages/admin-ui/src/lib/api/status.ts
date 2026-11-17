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

/** Asks shard 0's orchestrator to run the isolation probe again (`202`; `503` before shard 0 has published). */
export async function requestProbe(token: string): Promise<ProbeAnswer> {
  const res = await adminRequest(token, "/admin/status/probe", { method: "POST" });
  return (await res.json()) as ProbeAnswer;
}

/** What the observed-runtime cell says: `null` and the empty string are different facts. */
export function observedRuntimeText(value: string | null): string {
  if (value === null) return "not observed yet";
  if (value === "") return "node default (no runtimeClassName)";
  return value;
}

export function configuredRuntimeText(value: string): string {
  return value === "" ? "none set (node default)" : value;
}
