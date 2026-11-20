import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { cloneUrl } from "@cela/session-core";
import type { RepoSpec } from "@cela/session-core";
import { Redacted } from "./onecli.js";

export const WORKSPACE_ROOT = "/workspace";
export const REPO_DIR = `${WORKSPACE_ROOT}/repo`;
export const CLONE_TMP = `${WORKSPACE_ROOT}/.clone-tmp`;
/** Written once the clone is complete. If it is missing later, the workspace was lost and nothing recreates it. */
export const MARKER = `${WORKSPACE_ROOT}/.pi-workspace.json`;
/** Public material only: the OneCLI gateway CA, never a credential. */
export const CA_DIR = `${WORKSPACE_ROOT}/.onecli`;
export const CA_FILE = `${CA_DIR}/ca.pem`;
/** System roots plus the OneCLI CA. Hosts the gateway only tunnels (no injection) still present real certificates. */
export const CA_BUNDLE = `${CA_DIR}/bundle.pem`;
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

const CLONE_TIMEOUT_S = 600;

/** The part of `ExecutionEnv` the workspace needs; narrower so tests can run it on a local env. */
export type WorkspaceEnv = Pick<
  ExecutionEnv,
  | "exec"
  | "exists"
  | "createDir"
  | "remove"
  | "renameFile"
  | "writeFile"
  | "readTextFile"
  | "listDir"
  | "openBinaryReader"
>;

/** The workspace was ready once, but its marker or repository is gone (PVC replaced, files removed). Not re-cloned. */
export class WorkspaceLostError extends Error {}

/**
 * Environment of one repo session's tool commands, handed to pi-env as `shellEnv`: it is added to the remote
 * environment of every command of that session's env, and of no other session's.
 *
 * The proxy URL carries the session's OneCLI agent token as its password. The plan treats that token as readable by
 * the agent: what bounds it is the grant (one repository, via a GitHub App token that OneCLI injects and the sandbox
 * never sees), the session lifetime and deletion. `GIT_CONFIG_COUNT` is used instead of `GIT_CONFIG`, which only
 * `git config` reads; `proxyAuthMethod=basic` makes git send the proxy credentials at once (spike Q3).
 */
export function buildShellEnv(input: { gateway: string; token: Redacted }): Record<string, string> {
  const proxy = new URL(input.gateway);
  proxy.username = "x";
  proxy.password = input.token.reveal();
  const proxyUrl = proxy.toString().replace(/\/$/, "");
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.proxyAuthMethod",
    GIT_CONFIG_VALUE_0: "basic",
    ...buildWorkspaceEnv(),
  };
}

/**
 * What a repo session's commands need besides a proxy: the OneCLI CA (it MITMs the credentialed hosts, whichever proxy
 * the traffic enters through), git's non-interactive switches and the commit identity. No proxy variable and no
 * credential: the egress proxy environment (`buildEgressEnv`) adds the proxy, with the egress token only.
 */
export function buildWorkspaceEnv(): Record<string, string> {
  return {
    SSL_CERT_FILE: CA_BUNDLE,
    GIT_SSL_CAINFO: CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: CA_FILE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "pi agent",
    GIT_AUTHOR_EMAIL: "pi-agent@users.noreply.github.com",
    GIT_COMMITTER_NAME: "pi agent",
    GIT_COMMITTER_EMAIL: "pi-agent@users.noreply.github.com",
  };
}

/**
 * Whether a path exists. A failed check is thrown, not read as "absent": `exists` answers `ok: true, value: false`
 * for a missing path, so an error is the bridge or Pod failing, and calling that "workspace lost" would fail a
 * session for good (or start a needless clone) over a transient fault. The inbox retries the plain Error.
 */
async function exists(env: WorkspaceEnv, path: string): Promise<boolean> {
  return must(env.exists(path, context), `check ${path}`);
}

async function must<T>(
  result: Promise<{ ok: true; value: T } | { ok: false; error: Error }>,
  what: string,
): Promise<T> {
  const done = await result;
  if (!done.ok) throw new Error(`${what}: ${done.error.message}`);
  return done.value;
}

/** Writes the gateway CA and the bundle that git, curl and OpenSSL clients trust. Rewritten every time: it is public. */
async function writeCa(env: WorkspaceEnv, p: Paths, ca: string): Promise<void> {
  await must(env.createDir(p.caDir, { recursive: true }, context), "create CA directory");
  await must(env.writeFile(p.caFile, ca, context), "write the OneCLI CA");
  const system = await env.readTextFile(SYSTEM_BUNDLE, context);
  const bundle = system.ok ? `${system.value.trimEnd()}\n${ca}` : ca;
  await must(env.writeFile(p.caBundle, bundle, context), "write the CA bundle");
}

function pathsFor(root: string) {
  return {
    root,
    repo: `${root}/repo`,
    cloneTmp: `${root}/.clone-tmp`,
    marker: `${root}/.pi-workspace.json`,
    caDir: `${root}/.onecli`,
    caFile: `${root}/.onecli/ca.pem`,
    caBundle: `${root}/.onecli/bundle.pem`,
  };
}
type Paths = ReturnType<typeof pathsFor>;

export interface PrepareOptions {
  /** Only tests change this: the workspace root. */
  root?: string;
  /** PEM of the OneCLI gateway CA. */
  ca: string;
  sessionId: string;
  /** The session finished a clone before (`workspace_ready_at`). */
  wasReady: boolean;
  /** Only tests change this: the clone URL base. */
  gitBase?: string;
  now?: () => Date;
}

/**
 * Makes `/workspace/repo` exist, once. Idempotent and crash-safe: the clone goes to `/workspace/.clone-tmp` and is
 * renamed into place, so `/workspace/repo/.git` exists only for a complete clone, and that is what makes later calls
 * skip it. argv with `--` keeps the repo and branch from being read as options (both are also validated).
 * Returns "cloned" when it cloned, "present" when the repository was already there.
 *
 * A session that was ready before but now lacks its marker or repository is reported with WorkspaceLostError and
 * never cloned again behind the user's back.
 */
export async function prepareWorkspace(
  env: WorkspaceEnv,
  spec: RepoSpec,
  options: PrepareOptions,
): Promise<"cloned" | "present"> {
  const p = pathsFor(options.root ?? WORKSPACE_ROOT);
  await writeCa(env, p, options.ca);
  const hasRepo = await exists(env, `${p.repo}/.git`);
  const hasMarker = await exists(env, p.marker);
  if (options.wasReady && (!hasMarker || !hasRepo)) {
    throw new WorkspaceLostError(
      "the session's workspace is missing (repository or marker not found); it is not cloned again",
    );
  }
  let outcome: "cloned" | "present" = "present";
  if (!hasRepo) {
    await clone(env, p, spec, options.gitBase);
    outcome = "cloned";
  }
  if (!hasMarker || outcome === "cloned") {
    const marker = {
      version: 1,
      sessionId: options.sessionId,
      repo: spec.repo,
      ...(spec.branch === undefined ? {} : { branch: spec.branch }),
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await must(env.writeFile(p.marker, `${JSON.stringify(marker)}\n`, context), "write the marker");
  }
  return outcome;
}

async function clone(
  env: WorkspaceEnv,
  p: Paths,
  spec: RepoSpec,
  gitBase: string | undefined,
): Promise<void> {
  // A temp dir left by a crash during an earlier clone is incomplete by definition.
  await must(
    env.remove(p.cloneTmp, { recursive: true, force: true }, context),
    "clear the clone directory",
  );
  let tail = "";
  const run = await must(
    env.exec(
      [
        "git",
        "clone",
        ...(spec.branch === undefined ? [] : ["--branch", spec.branch]),
        "--",
        cloneUrl(spec.repo, gitBase),
        p.cloneTmp,
      ],
      {
        cwd: p.root,
        timeout: CLONE_TIMEOUT_S,
        onOutput: (text) => {
          tail = (tail + text).slice(-400);
        },
      },
      context,
    ),
    "git clone",
  );
  if (run.exitCode !== 0) {
    await env.remove(p.cloneTmp, { recursive: true, force: true }, context);
    throw new Error(`git clone failed (exit ${String(run.exitCode)}): ${tail.trim()}`);
  }
  await must(env.renameFile(p.cloneTmp, p.repo, context), "move the clone into place");
}
