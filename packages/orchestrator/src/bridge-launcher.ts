import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENV, deriveSandboxToken } from "@pi-durable-k8s/sandbox-env";

/**
 * Environment variables the bridge may keep. It needs the in-cluster Kubernetes endpoint (the SDK reads the
 * claim and Service through the API) and a working PATH/HOME. Everything else in the orchestrator's environment,
 * notably the database URL, the API tokens and the sandbox master key, stays out of the bridge process. The
 * sandboxd token is not copied from the parent: bridgeEnv derives it for the bridge's own claim only.
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

/** The value of the bridge's `--claim` flag. */
export function claimOf(argv: readonly string[]): string {
  const claim = argv[argv.indexOf("--claim") + 1];
  if (argv.indexOf("--claim") < 0 || claim === undefined || claim === "") {
    throw new Error("bridge-launcher: --claim <name> is required");
  }
  return claim;
}

/**
 * The bridge's environment: the allow-listed variables plus the sandboxd token of `claimName` only. The master
 * key is read here and dropped, so a bridge (and anything it spawns) can authenticate to its own sandbox and
 * to no other. A missing master throws: a bridge without a token could only fail later, less clearly.
 */
export function bridgeEnv(
  env: Readonly<Record<string, string | undefined>>,
  claimName: string,
): Record<string, string> {
  const master = env[ENV.masterKey];
  if (master === undefined || master === "") {
    throw new Error(`bridge-launcher: ${ENV.masterKey} is not set`);
  }
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED.has(name)) kept[name] = value;
  }
  kept[ENV.authToken] = deriveSandboxToken(master, claimName);
  return kept;
}

/**
 * The program pi-env's Connection spawns for a session. It starts the real bridge (sandbox-env's cli.js) with the
 * trimmed environment and passes stdio straight through, so the pi-env protocol is untouched. When pi-env
 * ends the connection (SIGTERM or closed stdin) the bridge ends too.
 */
function main(): void {
  const cli = fileURLToPath(import.meta.resolve("@pi-durable-k8s/sandbox-env")).replace(
    /index\.js$/,
    "cli.js",
  );
  const args = process.argv.slice(2);
  let env: Record<string, string>;
  try {
    env = bridgeEnv(process.env, claimOf(args));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}

// Only run when started as the launcher, not when a test imports bridgeEnv.
if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main();
}
