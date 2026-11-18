import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkProbeLoop, runNetworkProbe } from "../src/netprobe.js";
import type { ProbeIo } from "../src/netprobe.js";
import type { ProbeResult } from "../src/netprobe-verdict.js";

const io = (over: Partial<ProbeIo> = {}): ProbeIo => ({
  control: { host: "gateway", port: 10255 },
  targets: () => Promise.resolve([{ name: "postgres", host: "10.0.0.5", port: 5432 }]),
  reachableHere: () => Promise.resolve(true),
  runPod: () =>
    Promise.resolve({
      report: { dns: true, control: "connected", targets: { postgres: "timeout" } },
      failure: "",
    }),
  ...over,
});

describe("runNetworkProbe", () => {
  it("passes the targets and the control to the Pod and judges the report against the orchestrator's own check", async () => {
    const runPod = vi.fn(() =>
      Promise.resolve({
        report: {
          dns: true,
          control: "connected" as const,
          targets: { postgres: "timeout" as const },
        },
        failure: "",
      }),
    );
    const result = await runNetworkProbe(io({ runPod }));
    expect(runPod).toHaveBeenCalledWith({
      dnsName: "kubernetes.default.svc.cluster.local",
      control: { host: "gateway", port: 10255 },
      targets: [{ name: "postgres", host: "10.0.0.5", port: 5432 }],
    });
    expect(result.state).toBe("enforced");
  }, 1000);

  it("proxied: no DNS control, and the control address is resolved here because the Pod has no DNS", async () => {
    const runPod = vi.fn(() =>
      Promise.resolve({
        report: {
          dns: null,
          control: "connected" as const,
          targets: { postgres: "timeout" as const },
        },
        failure: "",
      }),
    );
    const result = await runNetworkProbe(
      io({ proxyOnly: true, control: { host: "127.0.0.1", port: 3128 }, runPod }),
    );
    expect(runPod).toHaveBeenCalledWith({
      control: { host: "127.0.0.1", port: 3128 },
      targets: [{ name: "postgres", host: "10.0.0.5", port: 5432 }],
    });
    expect(result.state).toBe("enforced");
    expect(result.controls).toEqual({ dns: null, allowedTcp: true });
  }, 1000);

  it("is inconclusive when the denied target is down for the orchestrator too", async () => {
    expect((await runNetworkProbe(io({ reachableHere: () => Promise.resolve(false) }))).state).toBe(
      "inconclusive",
    );
  }, 1000);
});

describe("NetworkProbeLoop", () => {
  afterEach(() => vi.useRealTimers());
  const pool = (requests: boolean[]) => {
    const queries: string[] = [];
    const calls: [string, unknown[]][] = [];
    const query = vi.fn((sql: string, params: unknown[] = []) => {
      queries.push(sql);
      calls.push([sql, params]);
      const claim = sql.includes("probe_requested_at = null");
      return Promise.resolve({ rows: [], rowCount: claim && requests.shift() === true ? 1 : 0 });
    });
    return { pool: { query } as unknown as pg.Pool, queries, calls };
  };
  const result: ProbeResult = { state: "not-enforced", reason: "x", controls: null, targets: [] };
  const tick = () => vi.advanceTimersByTimeAsync(5_000);

  it("runs at start and once per claimed request, and records state and detail", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve(result));
    const { pool: db, queries } = pool([false, true, false]);
    const loop = new NetworkProbeLoop(db, 0, run);
    loop.start(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await tick();
    await tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
    expect(queries.filter((q) => q.includes("network_policy = $2"))).toHaveLength(2);
    expect(queries.filter((q) => q.includes("network_policy = 'running'"))).toHaveLength(2);
  }, 2000);

  it("records an inconclusive result, never enforced, when the probe cannot run", async () => {
    vi.useFakeTimers();
    const { pool: db, calls } = pool([]);
    const loop = new NetworkProbeLoop(db, 0, () => Promise.reject(new Error("pods is forbidden")));
    loop.start(5_000);
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    const record = calls.find(([sql]) => sql.includes("network_policy = $2"));
    expect(record?.[1][1]).toBe("inconclusive");
    expect(String(record?.[1][2])).toContain("pods is forbidden");
  }, 2000);

  it("does not start a second run while one is in progress", async () => {
    vi.useFakeTimers();
    let release: (r: ProbeResult) => void = () => undefined;
    const run = vi.fn(() => new Promise<ProbeResult>((resolve) => (release = resolve)));
    const { pool: db } = pool([true, true]);
    const loop = new NetworkProbeLoop(db, 0, run);
    loop.start(5_000);
    await tick();
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    release(result);
    loop.stop();
  }, 2000);
});
