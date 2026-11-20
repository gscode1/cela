import { fileURLToPath } from "node:url";

/**
 * Environment variables the relay may keep. It is a node:net-only process that pipes stdio to the orchestrator's
 * in-process broker and needs nothing from the cluster, so only a working PATH/HOME and Node options stay. Everything
 * else in the orchestrator's environment, notably the database URL, the API tokens and the sandbox master key, stays
 * out. The sandboxd token is in no child process at all: the broker, inside the orchestrator, uses it.
 */
const ALLOWED = new Set(["PATH", "HOME", "TZ", "LANG", "NODE_OPTIONS"]);

/** The relay's environment: the allow-listed variables only. */
export function bridgeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && ALLOWED.has(name)) kept[name] = value;
  }
  return kept;
}

/** The relay program, sandbox-env's relay.js. `fileURLToPath` decodes the URL, so a `#` or `?` in the path is kept. */
function defaultRelay(): string {
  return fileURLToPath(import.meta.resolve("@cela/sandbox-env")).replace(/index\.js$/, "relay.js");
}

/**
 * argv prefix for pi-env's Connection (`relayCommand`); sandbox-env appends the socket, nonce and `--claim`. pi-env
 * spawns the program with the orchestrator's whole environment and has no env option, and a process's
 * `/proc/<pid>/environ` keeps the environment it started with, readable by every process of the same uid. So the relay
 * is exec'd through `env -i`: the process that starts is already the relay, with only the trimmed environment, and the
 * master key was never in any process it could read. The relay needs no token, so none is in its argv or environment.
 */
export function bridgeCommand(
  env: Readonly<Record<string, string | undefined>>,
  relay: string = defaultRelay(),
): string[] {
  const vars = Object.entries(bridgeEnv(env)).map(([name, value]) => `${name}=${value}`);
  return ["/usr/bin/env", "-i", ...vars, process.execPath, relay];
}
