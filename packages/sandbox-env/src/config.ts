import type { Connectivity, SandboxTarget } from "./sandbox-client.js";

/**
 * Environment contract of the bridge. Flags (`--claim`, `--namespace`, `--connectivity`) take
 * precedence so one orchestrator process can run bridges for many claims; pi-env's Connection
 * inherits the parent environment and offers no per-connection env. The token is env-only, so it
 * never shows up in a process listing.
 */
export const ENV = {
  claim: "PI_SANDBOX_CLAIM",
  namespace: "PI_SANDBOX_NAMESPACE",
  connectivity: "PI_SANDBOX_CONNECTIVITY",
  authToken: "PI_SANDBOX_AUTH_TOKEN",
  /** Master key per-sandbox tokens derive from (token.ts). Orchestrator and e2e driver only, never a bridge. */
  masterKey: "PI_SANDBOX_MASTER_KEY",
  envBinary: "PI_SANDBOX_ENV_BINARY",
} as const;

export const DEFAULT_ENV_BINARY = "/usr/local/bin/pi-env";

const CONNECTIVITIES: readonly Connectivity[] = [
  "in-cluster-service",
  "in-cluster-pod-ip",
  "port-forward",
];

export interface BridgeConfig {
  target: SandboxTarget;
  command: string;
  /** Everything after the bridge's own flags, i.e. `serve --token <hex>` from pi-env. */
  args: readonly string[];
}

const FLAGS = new Map([
  ["--claim", "claim"],
  ["--namespace", "namespace"],
  ["--connectivity", "connectivity"],
] as const);

export function parseBridgeArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): BridgeConfig {
  const flags: Partial<Record<"claim" | "namespace" | "connectivity", string>> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    const key = arg === undefined ? undefined : FLAGS.get(arg as "--claim");
    if (key === undefined) break;
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg ?? "flag"} needs a value`);
    flags[key] = value;
  }
  const args = argv.slice(i);
  if (args[0] !== "serve") throw new Error("expected `serve --token <hex>` after the bridge flags");

  const claimName = flags.claim ?? env[ENV.claim];
  if (!claimName) throw new Error(`sandbox claim missing: set ${ENV.claim} or pass --claim`);
  const namespace = flags.namespace ?? env[ENV.namespace];
  if (!namespace) throw new Error(`namespace missing: set ${ENV.namespace} or pass --namespace`);
  const connectivity = flags.connectivity ?? env[ENV.connectivity] ?? "in-cluster-service";
  if (!CONNECTIVITIES.includes(connectivity as Connectivity)) {
    throw new Error(`connectivity must be one of ${CONNECTIVITIES.join(", ")}`);
  }
  const authToken = env[ENV.authToken];
  return {
    target: {
      claimName,
      namespace,
      connectivity: connectivity as Connectivity,
      ...(authToken ? { authToken } : {}),
    },
    command: env[ENV.envBinary] || DEFAULT_ENV_BINARY,
    args,
  };
}
