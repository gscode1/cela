import { fileURLToPath } from "node:url";
import { ENV } from "@pi-durable-k8s/sandbox-env";

/**
 * Environment variables the bridge may keep. It needs the in-cluster Kubernetes endpoint (the SDK reads the
 * claim and Service through the API) and a working PATH/HOME. Everything else in the orchestrator's environment,
 * notably the database URL, the API tokens and the sandbox master key, stays out of the bridge process. The
 * sandboxd token is not copied from the parent: the orchestrator derives it for the bridge's own claim only.
 */
const ALLOWED = new Set([
  "PATH",
  "HOME",
  "TZ",
  "LANG",
  "NODE_OPTIONS",
  "KUBERNETES_SERVICE_HOST",
  "KUBERNETES_SERVICE_PORT",
  "KUBERNETES_SERVICE_PORT_HTTPS",
  "PI_SANDBOX_CONNECTIVITY",
  "PI_SANDBOX_ENV_BINARY",
]);

/**
 * The bridge's environment: the allow-listed variables plus the sandboxd token of its own claim, which the
 * orchestrator derived. The master key is never an input here, so the bridge can authenticate to its own sandbox and
 * to no other.
 */
export function bridgeEnv(
  env: Readonly<Record<string, string | undefined>>,
  token: string,
): Record<string, string> {
  if (token === "") throw new Error("bridge-launcher: the sandboxd token is empty");
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED.has(name)) kept[name] = value;
  }
  kept[ENV.authToken] = token;
  return kept;
}

/** The bridge program, sandbox-env's cli.js. `fileURLToPath` decodes the URL, so a `#` or `?` in the path is kept. */
function defaultCli(): string {
  return fileURLToPath(import.meta.resolve("@pi-durable-k8s/sandbox-env")).replace(
    /index\.js$/,
    "cli.js",
  );
}

/**
 * argv for pi-env's Connection (`bridgeCommand`). pi-env spawns the program with the orchestrator's whole environment
 * and has no env option, and a process's `/proc/<pid>/environ` keeps the environment it started with, readable by
 * every process of the same uid. So the bridge is exec'd through `env -i`: the process that starts is already the
 * bridge, with only the trimmed environment, and the master key was never in any process the bridge could read. The
 * token is its own claim's, passed as an argument (it is no more secret than the bridge's own environment).
 */
export function bridgeCommand(
  env: Readonly<Record<string, string | undefined>>,
  token: string,
  cli: string = defaultCli(),
): string[] {
  const vars = Object.entries(bridgeEnv(env, token)).map(([name, value]) => `${name}=${value}`);
  return ["/usr/bin/env", "-i", ...vars, process.execPath, cli];
}
