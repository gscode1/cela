import type pg from "pg";

export class MissingShardRoutesError extends Error {}

/** Deleted sessions still retain shard identity; shrinking routes must not strand any stored session. */
export async function assertSessionShardRoutes(
  db: Pick<pg.Pool, "query">,
  shards: number,
): Promise<void> {
  const result = await db.query<{ shard: number }>(
    "select distinct shard from inbox.sessions order by shard",
  );
  const missing = result.rows
    .map((row) => row.shard)
    .filter((shard) => shard < 0 || shard >= shards);
  if (missing.length > 0) {
    throw new MissingShardRoutesError(
      `No orchestrator route for session shards: ${missing.join(", ")}; increase PI_ORCH_SHARDS and configure PI_ORCH_URL`,
    );
  }
}
