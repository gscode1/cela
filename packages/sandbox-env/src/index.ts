import { fileURLToPath } from "node:url";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

import { BRIDGE_READY } from "./bridge.js";
import type { StartProcess } from "./bridge.js";
import { startBroker } from "./broker.js";
import { DEFAULT_ENV_BINARY, ENV } from "./config.js";
import { sandboxStart, waitSandboxReady } from "./sandbox-client.js";
import { StartGate, gatedStart } from "./start-gate.js";
import type { GatedStart } from "./start-gate.js";

/** One gate per process: all of this process's bridges cold-start through it. 45 s is above a slow start. */
const startGate = new StartGate(45_000);

export { runBridge } from "./bridge.js";
export type { BridgeOptions, RemoteProcess, StartProcess } from "./bridge.js";
export { ENV } from "./config.js";
export { startBroker } from "./broker.js";
export type { Broker, BrokerOptions } from "./broker.js";
export { ensureClaim } from "./sandbox-client.js";
export { SANDBOXD_TOKEN_SHA256_ENV, deriveSandboxToken, sandboxTokenSha256 } from "./token.js";
export type { ClaimRequest, Connectivity } from "./sandbox-client.js";

/**
 * `onLog` for pi-env's Connection. The gate is freed by the ready line (done in `start.onLog`) and also by the
 * bridge's own failure lines (`bridge: cannot start ...`, bad arguments): pi-env tells nobody when a bridge exits
 * before it is ready, so without this the gate stays held until its 45 s limit and delays every other sandbox's start.
 * A bridge line after ready (e.g. the end of the remote process) frees an already free gate: a no-op.
 */
export function freeGateOnBridgeLog(start: GatedStart, text: string): void {
  start.onLog(text);
  if (/^bridge: /m.test(text) && !text.includes(BRIDGE_READY)) start.release();
}

export interface SandboxEnvOptions {
  claimName: string;
  namespace: string;
  /** Working directory inside the sandbox; must exist there (e.g. the workspace mount). */
  cwd: string;
  /** File namespace for the env, e.g. `pi-env:<conversation id>`. */
  id: string;
  connectivity?: "in-cluster-service" | "in-cluster-pod-ip" | "port-forward";
  /**
   * Bearer token of this claim's sandboxd. It stays in this process (the broker's `start` uses it); the relay that
   * pi-env spawns never gets it.
   */
  authToken?: string;
  /** argv of the relay program. Defaults to `node <this package>/dist/relay.js`. */
  relayCommand?: readonly string[];
  /** Replaces the sandbox hop (tests). Defaults to the SDK's `commands.start()` through `sandboxStart`. */
  startProcess?: StartProcess;
  /** The program run inside the sandbox. Defaults to `PI_SANDBOX_ENV_BINARY`, then `/usr/local/bin/pi-env`. */
  envBinary?: string;
  shellPath?: string;
  /**
   * Added to the environment of every command this env runs (pi-env's `shellEnv`), and of no other env's. It goes
   * through the pi-env protocol to the daemon, not through the bridge's own environment.
   */
  shellEnv?: Record<string, string>;
  /**
   * Timing hook (docs/metrics.md): `bridge-started` when the start gate let this connection spawn its bridge,
   * `bridge-ready` when the bridge reported ready. Fires again for every respawn; must not throw.
   */
  onPhase?: (phase: "bridge-started" | "bridge-ready") => void;
  /**
   * Awaited before every relay respawn (not the first spawn, which follows the caller's own claim wait). Defaults to
   * waiting until the Sandbox is Ready, or to nothing when `startProcess` replaces the sandbox hop.
   */
  awaitSandbox?: () => Promise<void>;
}

export interface SandboxEnv {
  env: RemoteExecutionEnv;
  connection: Connection;
  /** The broker's 0700 socket directory; removed by `close()`. */
  brokerDir: string;
  /** Stops the relay and the broker; the daemon then ends its commands and exits. */
  close(): void;
}

/**
 * pi-env's Connection can only spawn a local program, so each env has an in-process broker (broker.ts) that runs the
 * bridge logic, and the program Connection spawns is a thin relay (relay.ts) that pipes its stdio to the broker's
 * unix socket. The sandboxd token is used by the broker's `start` and is in no child process. Connection appends
 * `serve --token <hex>` to the relay's argv, and respawns the relay when it exits; each spawn gets a fresh nonce.
 */
export function connectSandboxEnv(options: SandboxEnvOptions): SandboxEnv {
  const relay = options.relayCommand ?? [
    process.execPath,
    fileURLToPath(new URL("./relay.js", import.meta.url)),
  ];
  const target = {
    claimName: options.claimName,
    namespace: options.namespace,
    connectivity: options.connectivity ?? "in-cluster-service",
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  } as const;
  const broker = startBroker({
    start: options.startProcess ?? sandboxStart(target),
    command: options.envBinary ?? (process.env[ENV.envBinary] || DEFAULT_ENV_BINARY),
  });
  const start = gatedStart(startGate, async () => {
    await broker.ready;
    return [
      ...relay,
      "--socket",
      broker.socketPath,
      "--nonce",
      broker.issueNonce(),
      "--claim",
      options.claimName,
    ];
  });
  const onPhase = options.onPhase;
  const awaitSandbox =
    options.awaitSandbox ??
    (options.startProcess === undefined ? () => waitSandboxReady(target) : undefined);
  let spawned = false;
  const connection = new Connection({
    command: async () => {
      // A respawn usually follows a lost stream, often a Pod being replaced. pi-env starts its 30 s silence limit when
      // it spawns the relay, and the bridge's own wait for the new Pod (scheduling, the RWO workspace moving over) can
      // take longer than that under load: "pi-env connection timed out" (#122). Waiting here comes before the spawn,
      // so no pi-env timer runs yet, and before the start gate, so a waiting env does not hold other envs' starts.
      if (spawned) await awaitSandbox?.();
      spawned = true;
      const argv = await start.command();
      onPhase?.("bridge-started");
      return argv;
    },
    onLog: (text) => {
      freeGateOnBridgeLog(start, text);
      if (text.includes(BRIDGE_READY)) onPhase?.("bridge-ready");
    },
  });
  const env = new RemoteExecutionEnv({
    connection,
    id: options.id,
    cwd: options.cwd,
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
  });
  return {
    env,
    connection,
    brokerDir: broker.dir,
    close: () => {
      start.release();
      connection.close();
      broker.close();
    },
  };
}
