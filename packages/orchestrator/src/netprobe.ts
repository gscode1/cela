import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import {
  claimNetworkProbeRequest,
  markNetworkProbeRunning,
  recordNetworkProbe,
} from "@cela/session-core";
import type pg from "pg";
import { log } from "./log.js";
import { decide } from "./netprobe-verdict.js";
import type { DeniedTarget, PodReport, ProbeResult } from "./netprobe-verdict.js";
import type { ProbePlan } from "./netprobe-pod.js";

/** Where the probe finds each address. Everything is injected, so the runner is testable without a cluster. */
export interface ProbeIo {
  /** An address:port the probe should try from a sandbox's network position, resolved to IPs. */
  targets(): Promise<{ name: string; host: string; port: number }[]>;
  /** The allowed TCP control: the egress proxy; without it the OneCLI gateway, else a public address. */
  control: { host: string; port: number };
  /** The sandbox has the proxy only and no DNS (the network cutover, ADR 0038): no DNS control, an address for the control. */
  proxyOnly?: boolean;
  /** Pause before a probe is repeated because the proxy, its only allowed control, was not answering yet; default 10 s. */
  retryDelayMs?: number;
  /** TCP connect from the orchestrator, which is allowed to reach every denied target but the one it is. */
  reachableHere(host: string, port: number): Promise<boolean>;
  /** Starts the probe Pod with the plan, waits, returns its report, deletes the Pod. */
  runPod(plan: ProbePlan): Promise<{ report: PodReport | undefined; failure: string }>;
}

const DNS_CONTROL_NAME = "kubernetes.default.svc.cluster.local";

/**
 * With the proxy as the only allowed control, a probe at the orchestrator's start can run before the proxy is ready: the
 * control then fails and the verdict is `inconclusive`. That is repeated a few times before it is reported.
 */
export async function runNetworkProbe(io: ProbeIo): Promise<ProbeResult> {
  const attempts = io.proxyOnly === true ? 4 : 1;
  let result = await probeOnce(io);
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (result.state !== "inconclusive" || result.controls?.allowedTcp !== false) break;
    await new Promise<void>((resolve) => setTimeout(resolve, io.retryDelayMs ?? 10_000));
    result = await probeOnce(io);
  }
  return result;
}

async function probeOnce(io: ProbeIo): Promise<ProbeResult> {
  const found = await io.targets();
  const targets: DeniedTarget[] = await Promise.all(
    found.map(async (t) => ({
      name: t.name,
      address: `${t.host}:${String(t.port)}`,
      upFromOrchestrator: await io.reachableHere(t.host, t.port),
    })),
  );
  const control =
    io.proxyOnly === true
      ? { ...io.control, host: (await resolveHost(io.control.host)) ?? io.control.host }
      : io.control;
  const { report, failure } = await io.runPod({
    ...(io.proxyOnly === true ? {} : { dnsName: DNS_CONTROL_NAME }),
    control,
    targets: found,
  });
  return decide(targets, report, failure);
}

/** TCP connect with a short timeout; true only when the connection was accepted. */
export function connectsHere(host: string, port: number, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** One IPv4 address of a host name, so the probe Pod needs no DNS for its denied targets. */
export async function resolveHost(host: string): Promise<string | undefined> {
  if (net.isIP(host) !== 0) return host;
  try {
    return (await dns.lookup(host, { family: 4 })).address;
  } catch {
    return undefined;
  }
}

export const probePodName = (shard: number): string =>
  `pi-netprobe-${String(shard)}-${randomBytes(3).toString("hex")}`;

/**
 * Runs the probe at start and on request, on shard 0 only, and records each result. Why shard 0 and not every shard:
 * the policies select sandboxes by label and are namespace-wide, so one measurement covers the install, and N shards
 * would start N identical Pods against the same targets. Shard 0 is the one whose Service keeps the single-shard name;
 * the shard that owns the schema lock is the single owner of that row, so there is exactly one runner (a standby
 * process holds no row and runs nothing). A request waits at most one poll interval.
 */
export class NetworkProbeLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly shard: number,
    private readonly run: () => Promise<ProbeResult>,
  ) {}

  start(pollMs: number): void {
    void this.once("start");
    this.timer = setInterval(() => {
      void claimNetworkProbeRequest(this.pool, this.shard)
        .then((asked) => (asked ? this.once("request") : undefined))
        .catch((error: unknown) => {
          log("netprobe-poll-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async once(trigger: string): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await markNetworkProbeRunning(this.pool, this.shard);
      let result: ProbeResult;
      try {
        result = await this.run();
      } catch (error) {
        // Missing RBAC or an unreachable API: report it as inconclusive, never as enforced.
        const message = error instanceof Error ? error.message : String(error);
        result = {
          state: "inconclusive",
          reason: `the probe could not run: ${message}`,
          controls: null,
          targets: [],
        };
      }
      await recordNetworkProbe(this.pool, this.shard, result.state, result);
      const fields = {
        shard: this.shard,
        trigger,
        networkPolicy: result.state,
        reason: result.reason,
      };
      if (result.state === "enforced") log("network-policy-enforced", fields);
      else {
        log("network-policy-not-verified", {
          level: "warn",
          ...fields,
          message:
            result.state === "not-enforced"
              ? "NETWORK ISOLATION IS NOT ENFORCED: a sandbox can reach cluster services. The CNI does not enforce NetworkPolicy, or the policies are missing."
              : "Network isolation could not be verified. Nothing is blocked; sessions run.",
        });
      }
    } catch (error) {
      log("netprobe-record-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
