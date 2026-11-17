import { describe, expect, it, vi } from "vitest";
import { assertSessionShardRoutes } from "../src/shard-routes.ts";

describe("session shard routes", () => {
  it("queries every distinct session shard, including deleted sessions", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ shard: 0 }, { shard: 1 }] });
    await expect(assertSessionShardRoutes({ query }, 2)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("select distinct shard from inbox.sessions order by shard");
  }, 5_000);

  it("accepts an empty database", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(assertSessionShardRoutes({ query }, 1)).resolves.toBeUndefined();
  }, 5_000);

  it("lists all shards without routes instead of silently routing to shard zero", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ shard: 0 }, { shard: 2 }, { shard: 4 }] });
    await expect(assertSessionShardRoutes({ query }, 2)).rejects.toThrow(
      "No orchestrator route for session shards: 2, 4",
    );
  }, 5_000);
});
