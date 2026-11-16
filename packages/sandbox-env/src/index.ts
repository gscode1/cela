import { fileURLToPath } from "node:url";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

import { StartGate, gatedStart } from "./start-gate.js";

/** One gate per process: all of this process's bridges cold-start through it. 45 s is above a slow start. */
const startGate = new StartGate(45_000);

export { runBridge } from "./bridge.js";
export type { BridgeOptions, RemoteProcess, StartProcess } from "./bridge.js";
export { ENV } from "./config.js";
export { ensureClaim } from "./sandbox-client.js";
export { SANDBOXD_TOKEN_SHA256_ENV, deriveSandboxToken, sandboxTokenSha256 } from "./token.js";
export type { ClaimRequest, Connectivity } from "./sandbox-client.js";

export interface SandboxEnvOptions {
  claimName: string;
  namespace: string;
  /** Working directory inside the sandbox; must exist there (e.g. the workspace mount). */
  cwd: string;
  /** File namespace for the env, e.g. `pi-env:<conversation id>`. */
  id: string;
  connectivity?: "in-cluster-service" | "in-cluster-pod-ip" | "port-forward";
  /** argv of the bridge program. Defaults to `node <this package>/dist/cli.js`. */
  bridgeCommand?: readonly string[];
  shellPath?: string;
  /**
   * Added to the environment of every command this env runs (pi-env's `shellEnv`), and of no other env's. It goes
   * through the pi-env protocol to the daemon, not through the bridge's own environment.
   */
  shellEnv?: Record<string, string>;
}

export interface SandboxEnv {
  env: RemoteExecutionEnv;
  connection: Connection;
  /** Stops the bridge; the daemon then ends its commands and exits. */
  close(): void;
}

/**
 * pi-env's Connection can only spawn a local program, so the sandbox hop is a bridge process that
 * receives the `serve --token` arguments Connection appends. The sandboxd token is read by the
 * bridge from its own PI_SANDBOX_AUTH_TOKEN, which bridge-launcher derives per claim (see token.ts).
 */
export function connectSandboxEnv(options: SandboxEnvOptions): SandboxEnv {
  const bridge = options.bridgeCommand ?? [
    process.execPath,
    fileURLToPath(new URL("./cli.js", import.meta.url)),
  ];
  const start = gatedStart(startGate, [
    ...bridge,
    "--claim",
    options.claimName,
    "--namespace",
    options.namespace,
    ...(options.connectivity ? ["--connectivity", options.connectivity] : []),
  ]);
  const connection = new Connection({ command: start.command, onLog: start.onLog });
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
    close: () => {
      start.release();
      connection.close();
    },
  };
}
