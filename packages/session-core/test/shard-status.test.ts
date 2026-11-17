import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { startShardStatus, observeShardRuntime, readShardStatus } from "../src/shard-status.ts";

describe("shard status store", () => {
  it("resets observations at start and upserts only the named shard", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as pg.Pool;
    await startShardStatus(pool, 2, "gvisor");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("on conflict (shard)"), [
      2,
      "gvisor",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain(
      "observed_runtime = null, network_policy = 'unknown'",
    );
    await observeShardRuntime(pool, 2, "");
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("where shard = $1"), [2, ""]);
  }, 1000);
  it("reads all shards ordered by shard, including null and empty runtime observations", async () => {
    const rows = [
      {
        shard: 0,
        configuredRuntime: "gvisor",
        observedRuntime: null,
        networkPolicy: "unknown",
        updatedAt: new Date(0),
      },
      {
        shard: 1,
        configuredRuntime: "",
        observedRuntime: "",
        networkPolicy: "unknown",
        updatedAt: new Date(0),
      },
    ];
    const query = vi.fn().mockResolvedValue({ rows });
    expect(await readShardStatus({ query } as unknown as pg.Pool)).toEqual(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("order by shard"));
  }, 1000);
});
