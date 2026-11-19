import type pg from "pg";

export interface ShardStatus {
  shard: number;
  configuredRuntime: string;
  observedRuntime: string | null;
  /** The namespace-wide isolation state, the same on every shard row (see `readShardStatus`). */
  networkPolicy: NetworkPolicyState;
  /** When the probe last finished; null until it has. Only shard 0 runs it, so only its row carries this. */
  networkPolicyCheckedAt: Date | null;
  /** What the probe saw (targets, controls, reason). Shard 0's row only. */
  networkPolicyDetail: unknown;
  /** When an admin asked for a probe that the orchestrator has not taken yet; null when none waits. Shard 0's row only. */
  probeRequestedAt: Date | null;
  updatedAt: Date;
}

/** `unknown` until the probe has run, `running` while it does; the rest is its verdict (docs/network-policy.md). */
export type NetworkPolicyState =
  "unknown" | "running" | "enforced" | "not-enforced" | "inconclusive";

/** The shard whose orchestrator runs the probe: the policies are namespace-wide, one probe covers every shard. */
export const PROBE_SHARD = 0;

/** A new process must not report its predecessor's observations as its own. */
export async function startShardStatus(
  pool: pg.Pool,
  shard: number,
  runtime: string,
): Promise<void> {
  await pool.query(
    `insert into inbox.shard_status (shard, configured_runtime) values ($1, $2)
    on conflict (shard) do update set configured_runtime = excluded.configured_runtime,
    observed_runtime = null, network_policy = 'unknown', network_policy_checked_at = null,
    network_policy_detail = null, probe_requested_at = null, mcp_discovery = '{}'::jsonb, updated_at = clock_timestamp()`,
    [shard, runtime],
  );
}

export async function observeShardRuntime(
  pool: pg.Pool,
  shard: number,
  runtime: string,
): Promise<void> {
  await pool.query(
    `update inbox.shard_status set observed_runtime = $2, updated_at = clock_timestamp() where shard = $1`,
    [shard, runtime],
  );
}

export async function markNetworkProbeRunning(pool: pg.Pool, shard: number): Promise<void> {
  await pool.query(
    `update inbox.shard_status set network_policy = 'running', updated_at = clock_timestamp() where shard = $1`,
    [shard],
  );
}

export async function recordNetworkProbe(
  pool: pg.Pool,
  shard: number,
  state: Exclude<NetworkPolicyState, "unknown" | "running">,
  detail: unknown,
): Promise<void> {
  await pool.query(
    `update inbox.shard_status set network_policy = $2, network_policy_detail = $3,
    network_policy_checked_at = clock_timestamp(), updated_at = clock_timestamp() where shard = $1`,
    [shard, state, JSON.stringify(detail)],
  );
}

export type ProbeRequest = "requested" | "running" | "no-shard";

/** Ingest's side: ask shard 0 for a run. A run already in progress answers the request, so none is queued. */
export async function requestNetworkProbe(pool: pg.Pool): Promise<ProbeRequest> {
  const asked = await pool.query(
    `update inbox.shard_status set probe_requested_at = clock_timestamp()
    where shard = $1 and network_policy <> 'running'`,
    [PROBE_SHARD],
  );
  if ((asked.rowCount ?? 0) > 0) return "requested";
  const row = await pool.query("select 1 from inbox.shard_status where shard = $1", [PROBE_SHARD]);
  return (row.rowCount ?? 0) > 0 ? "running" : "no-shard";
}

/** The orchestrator's side: takes a pending request, so two polls never start two runs for one request. */
export async function claimNetworkProbeRequest(pool: pg.Pool, shard: number): Promise<boolean> {
  const taken = await pool.query(
    `update inbox.shard_status set probe_requested_at = null where shard = $1 and probe_requested_at is not null`,
    [shard],
  );
  return (taken.rowCount ?? 0) > 0;
}

/**
 * Every row shows the namespace's state, which only shard 0 measures: a shard's own row says `unknown` for as long as
 * it lives, and that must not read as "isolation unverified on shard 1" while shard 0 reports `enforced`.
 */
export async function readShardStatus(pool: pg.Pool): Promise<ShardStatus[]> {
  const { rows } =
    await pool.query<ShardStatus>(`select shard, configured_runtime as "configuredRuntime",
    observed_runtime as "observedRuntime", network_policy as "networkPolicy",
    network_policy_checked_at as "networkPolicyCheckedAt", network_policy_detail as "networkPolicyDetail",
    probe_requested_at as "probeRequestedAt", updated_at as "updatedAt" from inbox.shard_status order by shard`);
  const probed = rows.find((row) => row.shard === PROBE_SHARD);
  if (probed === undefined) return rows;
  return rows.map((row) =>
    row.shard === PROBE_SHARD
      ? row
      : {
          ...row,
          networkPolicy: probed.networkPolicy,
          networkPolicyCheckedAt: null,
          networkPolicyDetail: null,
          probeRequestedAt: null,
        },
  );
}
