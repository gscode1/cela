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
      JSON.stringify({ default: { configured: "gvisor", observed: null, insecure: false } }),
    ]);
    expect(query.mock.calls[0]?.[0]).toContain(
      "observed_runtime = null, network_policy = 'unknown'",
    );
    await observeShardRuntime(pool, 2, "");
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("where shard = $1"), [2, ""]);
  }, 1000);

  it("starts with a configured entry for the default runtime and every named one, none observed", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await startShardStatus({ query } as unknown as pg.Pool, 0, "runc", {
      gvisorkvm: { configured: "gvisor-kvm", insecure: false },
      runc: { configured: "runc-sandbox", insecure: true },
    });
    expect(query.mock.calls[0]?.[0]).toContain("runtimes = excluded.runtimes");
    expect(JSON.parse(String((query.mock.calls[0]?.[1] as unknown[])[2]))).toEqual({
      default: { configured: "runc", observed: null, insecure: true },
      gvisorkvm: { configured: "gvisor-kvm", observed: null, insecure: false },
      runc: { configured: "runc-sandbox", observed: null, insecure: true },
    });
  }, 1000);

  it("a default attach writes the top-level observation and the default key, nothing else", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await observeShardRuntime({ query } as unknown as pg.Pool, 1, "gvisor", null);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("observed_runtime = $2");
    expect(sql).toContain("'{default,observed}'");
    expect(query.mock.calls[0]?.[1]).toEqual([1, "gvisor"]);
  }, 1000);

  it("a named attach sets only its own key with jsonb_set and never the top-level observation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await observeShardRuntime({ query } as unknown as pg.Pool, 1, "gvisor-kvm", "gvisorkvm");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("jsonb_set(runtimes, array[$3::text, 'observed']");
    expect(sql).not.toContain("observed_runtime");
    expect(query.mock.calls[0]?.[1]).toEqual([1, "gvisor-kvm", "gvisorkvm"]);
  }, 1000);
  it("reads all shards ordered by shard, including null and empty runtime observations", async () => {
    const rows = [
      {
        shard: 0,
        configuredRuntime: "gvisor",
        observedRuntime: null,
        runtimes: {},
        networkPolicy: "unknown",
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
        probeRequestedAt: null,
        updatedAt: new Date(0),
      },
      {
        shard: 1,
        configuredRuntime: "",
        observedRuntime: "",
        runtimes: {},
        networkPolicy: "unknown",
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
        probeRequestedAt: null,
        updatedAt: new Date(0),
      },
    ];
    const query = vi.fn().mockResolvedValue({ rows });
    expect(await readShardStatus({ query } as unknown as pg.Pool)).toEqual(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("order by shard"));
    expect(query.mock.calls[0]?.[0]).toContain('probe_requested_at as "probeRequestedAt"');
  }, 1000);

  it("shows shard 0's isolation verdict on every row, with the detail on shard 0 only", async () => {
    const checked = new Date(5);
    const base = {
      configuredRuntime: "gvisor",
      observedRuntime: null,
      runtimes: {},
      updatedAt: new Date(0),
    };
    const rows = [
      {
        ...base,
        shard: 0,
        networkPolicy: "enforced",
        networkPolicyCheckedAt: checked,
        networkPolicyDetail: { reason: "r" },
        probeRequestedAt: new Date(9),
      },
      {
        ...base,
        shard: 1,
        networkPolicy: "unknown",
        networkPolicyCheckedAt: null,
        networkPolicyDetail: null,
        probeRequestedAt: new Date(9),
      },
    ];
    const out = await readShardStatus({
      query: vi.fn().mockResolvedValue({ rows }),
    } as unknown as pg.Pool);
    expect(out.map((r) => r.networkPolicy)).toEqual(["enforced", "enforced"]);
    expect(out[0]?.networkPolicyDetail).toEqual({ reason: "r" });
    expect(out[1]?.networkPolicyDetail).toBeNull();
    expect(out.map((r) => r.probeRequestedAt)).toEqual([new Date(9), null]);
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
