import type pg from "pg";

export interface ShardStatus {
  shard: number;
  configuredRuntime: string;
  observedRuntime: string | null;
  networkPolicy: string;
  updatedAt: Date;
}

/** A new process must not report its predecessor's observations as its own. */
export async function startShardStatus(
  pool: pg.Pool,
  shard: number,
  runtime: string,
): Promise<void> {
  await pool.query(
    `insert into inbox.shard_status (shard, configured_runtime) values ($1, $2)
    on conflict (shard) do update set configured_runtime = excluded.configured_runtime,
    observed_runtime = null, network_policy = 'unknown', updated_at = clock_timestamp()`,
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

export async function readShardStatus(pool: pg.Pool): Promise<ShardStatus[]> {
  const { rows } =
    await pool.query<ShardStatus>(`select shard, configured_runtime as "configuredRuntime",
    observed_runtime as "observedRuntime", network_policy as "networkPolicy", updated_at as "updatedAt"
    from inbox.shard_status order by shard`);
  return rows;
}
