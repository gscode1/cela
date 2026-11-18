import { readFile } from "node:fs/promises";
import type pg from "pg";
import { markWorkspaceReady, setOneCliObjects } from "@pi-durable-k8s/session-core";
import type { SessionRow } from "@pi-durable-k8s/session-core";
import { loadGithubApp, mintInstallationToken } from "./github-app.js";
import type { FetchLike } from "./github-app.js";
import { log } from "./log.js";
import type { Redacted } from "./onecli.js";
import {
  agentIdentifier,
  DEFAULT_ONECLI_NAME_PREFIX,
  secretName,
  validateNamePrefix,
} from "./onecli-names.js";
import { OneCliError } from "./onecli-admin.js";
import type { OneCliAdmin, OneCliGrant } from "./onecli-admin.js";
import { buildShellEnv, prepareWorkspace } from "./workspace.js";
import type { WorkspaceEnv } from "./workspace.js";

// Re-exported: the names are built here and in the sweep from the same module.
export { agentIdentifier } from "./onecli-names.js";

/** A repo session that cannot be served and never will be without an operator: not configured, repo not installed. */
export class RepoUnavailableError extends Error {}

/** The grant check proved the agent holds more than the session's own secrets (as opposed to failing to check). */
class AgentNotNarrowError extends Error {}

/** Re-mint when the token has less than this left: a command can run for a long while after the check. */
const REMINT_BEFORE_MS = 10 * 60 * 1000;

export interface RepoAccessDeps {
  pool: Pick<pg.Pool, "query">;
  /** Undefined when `ONECLI_API_KEY` is not set: repo sessions are then refused. */
  onecli: OneCliAdmin | undefined;
  /**
   * Whether the live repo allowlist still lists the repository (docs/decisions/0030-repo-allowlist.md). Asked before
   * every mint, so a repository an admin removes gets no new token and its session's access ends with the current one.
   */
  repoAllowed: (repo: string) => boolean;
  /** Directory of the mounted GitHub App secret. */
  githubAppDir: string;
  /** Proxy URL of the gateway, without credentials. */
  gateway: string;
  /** File holding the OneCLI CA PEM (the mounted ConfigMap). */
  caFile: string;
  fetch: FetchLike;
  /** Prefix of every agent and secret name (`PI_ONECLI_NAME_PREFIX`); the sweep of this orchestrator judges only these. */
  namePrefix?: string | undefined;
  now?: () => number;
  /** Only tests change these. */
  githubApi?: string;
  gitBase?: string;
}

interface Access {
  agentId: string;
  secretIds: string[];
  /** The agent's `aoc_...` token: the proxy password handed to this session's commands. */
  proxyToken: Redacted;
  /** When the GitHub token now stored in the secrets stops working. */
  expiresAt: number;
}

/** Names are derived from the session id, so a crash between creating an object and storing its id leaves it findable. */
const SECRET_SUFFIXES = [
  { suffix: "git", host: "github.com", header: "Authorization", format: "Basic {value}" },
  { suffix: "api", host: "api.github.com", header: "Authorization", format: "Bearer {value}" },
] as const;

/**
 * Everything a repo session needs from GitHub and OneCLI, kept per session and rebuilt from OneCLI after a restart:
 *
 *  - a OneCLI agent `<prefix><uuid>` (prefix `pi-session-` unless `PI_ONECLI_NAME_PREFIX` says otherwise) whose only grants are this session's two GitHub secrets;
 *  - those secrets (host `github.com`: `Authorization: Basic base64("x-access-token:<token>")`, host `api.github.com`:
 *    `Bearer <token>`), holding a one-hour installation token for exactly this repository, minted by our own GitHub
 *    App (OneCLI v2 cannot scope a GitHub connection to a repository);
 *  - the token re-minted on every cold `ensure` and before it expires.
 *
 * Plain sessions never reach this class's OneCLI calls: every entry point returns at `session.repo === null`.
 */
export class RepoAccess {
  readonly #deps: RepoAccessDeps;
  readonly #prefix: string;
  readonly #access = new Map<string, Access>();
  readonly #byConversation = new Map<number, SessionRow>();
  readonly #inFlight = new Map<string, Promise<Access>>();
  readonly #prepared = new Set<string>();
  /** The proxy token each conversation's env was opened with, to notice when the agent is replaced under it. */
  readonly #envToken = new Map<number, string>();

  constructor(deps: RepoAccessDeps) {
    this.#deps = deps;
    this.#prefix = validateNamePrefix(deps.namePrefix ?? DEFAULT_ONECLI_NAME_PREFIX);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** The `shellEnv` of a repo session's env, provisioning OneCLI first if needed. Undefined for a plain session. */
  async shellEnv(
    session: SessionRow,
    conversationId: number,
  ): Promise<Record<string, string> | undefined> {
    if (session.repo === null) return undefined;
    this.#byConversation.set(conversationId, session);
    const access = await this.ensureAccess(session);
    this.#envToken.set(conversationId, access.proxyToken.reveal());
    return buildShellEnv({ gateway: this.#deps.gateway, token: access.proxyToken });
  }

  /**
   * True when the open env of this conversation was built with a proxy token that is no longer the session's: the
   * agent was replaced (revoked after a failed grant check, or deleted out of band), so the env's `shellEnv` points at
   * a dead token. The caller closes the env; the next open reads the current token through `shellEnv`.
   */
  envStale(conversationId: number): boolean {
    const session = this.#byConversation.get(conversationId);
    const handed = this.#envToken.get(conversationId);
    const access = session === undefined ? undefined : this.#access.get(session.id);
    return handed !== undefined && access !== undefined && access.proxyToken.reveal() !== handed;
  }

  /** Called before each tool call of an open env: renews a GitHub token that is about to expire. No-op otherwise. */
  async beforeUse(conversationId: number): Promise<void> {
    const session = this.#byConversation.get(conversationId);
    if (session === undefined) return;
    const access = this.#access.get(session.id);
    if (access !== undefined && access.expiresAt - this.#now() > REMINT_BEFORE_MS) return;
    await this.ensureAccess(session);
  }

  /** Agent, secrets, narrow grants and a fresh token. Serialised per session; warm calls only check the expiry. */
  ensureAccess(session: SessionRow): Promise<Access> {
    const running = this.#inFlight.get(session.id);
    if (running !== undefined) return running;
    const work = this.#ensure(session).finally(() => this.#inFlight.delete(session.id));
    this.#inFlight.set(session.id, work);
    return work;
  }

  async #ensure(session: SessionRow): Promise<Access> {
    const { onecli } = this.#deps;
    if (session.repo === null) throw new Error("not a repo session");
    if (onecli === undefined) {
      throw new RepoUnavailableError(
        "repository workspaces are not configured: ONECLI_API_KEY is not set",
      );
    }
    const warm = this.#access.get(session.id);
    if (warm !== undefined && warm.expiresAt - this.#now() > REMINT_BEFORE_MS) return warm;
    if (!this.#deps.repoAllowed(session.repo.repo)) {
      throw new RepoUnavailableError(`repo "${session.repo.repo}" is not on the repo allowlist`);
    }

    const minted = await this.#mint(session.repo.repo);
    const gitValue = Buffer.from(`x-access-token:${minted.token.reveal()}`).toString("base64");
    const valueOf = (suffix: string): string =>
      suffix === "git" ? gitValue : minted.token.reveal();

    const identifier = agentIdentifier(session.id, this.#prefix);
    const { agent, created } = await onecli.ensureAgent(identifier);
    const existing = new Map((await onecli.listSecrets()).map((s) => [s.name, s.id]));
    const secretIds: string[] = [];
    for (const spec of SECRET_SUFFIXES) {
      const name = secretName(session.id, spec.suffix, this.#prefix);
      const known = existing.get(name);
      if (known !== undefined) {
        await onecli.updateSecretValue(known, valueOf(spec.suffix));
        secretIds.push(known);
        continue;
      }
      const id = await onecli.ensureSecret({
        name,
        value: valueOf(spec.suffix),
        hostPattern: spec.host,
        header: spec.header,
        valueFormat: spec.format,
      });
      secretIds.push(id);
    }

    try {
      await this.#narrow(agent.id, secretIds);
    } catch (error) {
      // This agent was proven narrow by an earlier attempt (its id was stored after that) and is not new, so a failure
      // that is not "still wide" (a listGrants or network error) says nothing about its grants. Replacing it would
      // kill the proxy token the open env was built with; keep it and let the next call retry.
      const proven = !created && session.onecli?.agentId === agent.id;
      if (proven && !(error instanceof AgentNotNarrowError)) throw error;
      // An agent that might hold more than this session's secrets must not outlive the failed attempt.
      await this.#revoke(session.id, agent.id, secretIds).catch(() => undefined);
      this.#access.delete(session.id);
      throw error;
    }

    const stored = session.onecli;
    if (stored?.agentId !== agent.id || stored.secretIds.join() !== secretIds.join()) {
      await setOneCliObjects(this.#deps.pool, session.id, agent.id, secretIds);
    }
    const access: Access = {
      agentId: agent.id,
      secretIds,
      proxyToken: agent.accessToken,
      expiresAt: minted.expiresAt.getTime(),
    };
    this.#access.set(session.id, access);
    log("repo-access-ready", { session: session.id, repo: session.repo.repo, created });
    return access;
  }

  async #mint(repo: string): ReturnType<typeof mintInstallationToken> {
    let app;
    try {
      app = await loadGithubApp(this.#deps.githubAppDir);
    } catch (error) {
      throw new RepoUnavailableError(
        error instanceof Error ? error.message : "GitHub App secret is not available",
      );
    }
    return mintInstallationToken(app, repo, this.#deps.fetch, this.#now(), this.#deps.githubApi);
  }

  /**
   * OneCLI grants every new agent the LLM keys (seen live), so after creating the agent every grant except this
   * session's own two secrets is removed, then the grant list is read back and must be exactly those two. An answer
   * that cannot be read counts as a failure: the agent is not used unless it is proven narrow.
   */
  async #narrow(agentId: string, secretIds: readonly string[]): Promise<void> {
    const { onecli } = this.#deps;
    if (onecli === undefined) throw new Error("OneCLI is not configured");
    const mine = new Set(secretIds);
    const have = await onecli.listGrants(agentId);
    for (const id of mine) {
      if (!have.some((g) => g.kind === "secret" && g.id === id))
        await onecli.grantSecret(agentId, id);
    }
    for (const grant of have) {
      if (grant.kind === "secret" && mine.has(grant.id)) continue;
      await onecli.revokeGrant(agentId, grant);
    }
    const left: OneCliGrant[] = await onecli.listGrants(agentId);
    const ok =
      left.length === mine.size && left.every((g) => g.kind === "secret" && mine.has(g.id));
    if (!ok) {
      throw new AgentNotNarrowError(
        `OneCLI agent still holds ${String(left.length)} grants after narrowing; expected only the session's GitHub secrets`,
      );
    }
  }

  /**
   * Before the first turn of a repo session: provision, then clone through the session's env. Returns quickly once
   * done in this process; after a restart it runs again, which re-mints the token and finds the clone present.
   */
  async prepare(session: SessionRow, env: WorkspaceEnv): Promise<void> {
    const spec = session.repo;
    if (spec === null) return;
    await this.ensureAccess(session);
    if (this.#prepared.has(session.id)) return;
    let ca: string;
    try {
      ca = await readFile(this.#deps.caFile, "utf8");
    } catch {
      throw new RepoUnavailableError(`the OneCLI CA is not available at ${this.#deps.caFile}`);
    }
    const outcome = await prepareWorkspace(env, spec, {
      ca,
      sessionId: session.id,
      wasReady: session.workspaceReadyAt !== null,
      ...(this.#deps.gitBase === undefined ? {} : { gitBase: this.#deps.gitBase }),
    });
    await markWorkspaceReady(this.#deps.pool, session.id);
    this.#prepared.add(session.id);
    // `workspace-cloned` once per session; `workspace-present` after a restart. tests/e2e/run-phase4c.sh greps both.
    log(outcome === "cloned" ? "workspace-cloned" : "workspace-present", {
      session: session.id,
      repo: spec.repo,
    });
  }

  /**
   * Revokes everything the session held in OneCLI: the agent first (its token fails at once), then the secrets.
   * Looks objects up by name as well as by stored id, so a crash between creating an object and storing its id
   * cannot leave one behind. Idempotent. A plain session has nothing and makes no OneCLI call.
   */
  async teardown(session: SessionRow): Promise<void> {
    if (session.repo === null) return;
    const { onecli } = this.#deps;
    this.#forget(session.id);
    if (onecli === undefined) {
      if (session.onecli === null) return;
      throw new Error("cannot revoke the session's OneCLI agent: ONECLI_API_KEY is not set");
    }
    await this.#revoke(session.id, session.onecli?.agentId, session.onecli?.secretIds ?? []);
    log("repo-access-revoked", { session: session.id });
  }

  /**
   * The orphan sweep's revoke: removes whatever OneCLI still holds under this session's names (agent first, then the
   * secrets), with no session row needed. Nothing is stored for a session that is deleted or unknown.
   */
  async revokeSession(sessionId: string): Promise<void> {
    this.#forget(sessionId);
    await this.#revoke(sessionId, undefined, []);
  }

  async #revoke(
    sessionId: string,
    agentId: string | undefined,
    secretIds: readonly string[],
  ): Promise<void> {
    const { onecli } = this.#deps;
    if (onecli === undefined) return;
    const agents = (await onecli.listAgents())
      .filter((a) => a.identifier === agentIdentifier(sessionId, this.#prefix))
      .map((a) => a.id);
    for (const id of new Set([...(agentId === undefined ? [] : [agentId]), ...agents])) {
      await onecli.deleteAgent(id);
    }
    const names = new Set(
      SECRET_SUFFIXES.map((s) => secretName(sessionId, s.suffix, this.#prefix)),
    );
    const named = (await onecli.listSecrets()).filter((s) => names.has(s.name)).map((s) => s.id);
    for (const id of new Set([...secretIds, ...named])) {
      try {
        await onecli.deleteSecret(id);
      } catch (error) {
        if (!(error instanceof OneCliError && error.status === 404)) throw error;
      }
    }
  }

  #forget(sessionId: string): void {
    this.#access.delete(sessionId);
    this.#prepared.delete(sessionId);
    for (const [conversationId, session] of this.#byConversation) {
      if (session.id === sessionId) {
        this.#byConversation.delete(conversationId);
        this.#envToken.delete(conversationId);
      }
    }
  }
}
