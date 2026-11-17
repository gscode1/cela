import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  claimNetworkProbeRequest,
  markNetworkProbeRunning,
  observeShardRuntime,
  readShardStatus,
  recordNetworkProbe,
  requestNetworkProbe,
  startShardStatus,
} from "../src/shard-status.ts";

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
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
        updatedAt: new Date(0),
      },
      {
        shard: 1,
        configuredRuntime: "",
        observedRuntime: "",
        networkPolicy: "unknown",
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
        updatedAt: new Date(0),
      },
    ];
    const query = vi.fn().mockResolvedValue({ rows });
    expect(await readShardStatus({ query } as unknown as pg.Pool)).toEqual(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("order by shard"));
  }, 1000);

  it("shows shard 0's isolation verdict on every row, with the detail on shard 0 only", async () => {
    const checked = new Date(5);
    const base = { configuredRuntime: "gvisor", observedRuntime: null, updatedAt: new Date(0) };
    const rows = [
      {
        ...base,
        shard: 0,
        networkPolicy: "enforced",
        networkPolicyCheckedAt: checked,
        networkPolicyDetail: { reason: "r" },
      },
      {
        ...base,
        shard: 1,
        networkPolicy: "unknown",
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
      },
    ];
    const out = await readShardStatus({
      query: vi.fn().mockResolvedValue({ rows }),
    } as unknown as pg.Pool);
    expect(out.map((r) => r.networkPolicy)).toEqual(["enforced", "enforced"]);
    expect(out[0]?.networkPolicyDetail).toEqual({ reason: "r" });
    expect(out[1]?.networkPolicyDetail).toBeNull();
  }, 1000);

  it("records a probe result with its time and detail on the named shard", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const pool = { query } as unknown as pg.Pool;
    await markNetworkProbeRunning(pool, 0);
    await recordNetworkProbe(pool, 0, "not-enforced", { reason: "x" });
    expect(query.mock.calls[0]?.[0]).toContain("network_policy = 'running'");
    expect(query.mock.calls[1]?.[0]).toContain("network_policy_checked_at = clock_timestamp()");
    expect(query.mock.calls[1]?.[1]).toEqual([0, "not-enforced", '{"reason":"x"}']);
  }, 1000);

  it("asks shard 0 for a run unless one is running, and tells a missing shard apart", async () => {
    const answer = (updated: number, exists: number) =>
      vi
        .fn()
        .mockResolvedValueOnce({ rowCount: updated })
        .mockResolvedValueOnce({ rowCount: exists });
    const ask = async (q: ReturnType<typeof answer>) =>
      requestNetworkProbe({ query: q } as unknown as pg.Pool);
    const requested = answer(1, 0);
    expect(await ask(requested)).toBe("requested");
    expect(requested.mock.calls[0]?.[0]).toContain("network_policy <> 'running'");
    expect(requested.mock.calls[0]?.[1]).toEqual([0]);
    expect(await ask(answer(0, 1))).toBe("running");
    expect(await ask(answer(0, 0))).toBe("no-shard");
  }, 1000);

  it("claims a pending request once", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const pool = { query } as unknown as pg.Pool;
    expect(await claimNetworkProbeRequest(pool, 0)).toBe(true);
    expect(await claimNetworkProbeRequest(pool, 0)).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain("probe_requested_at is not null");
  }, 1000);
});
