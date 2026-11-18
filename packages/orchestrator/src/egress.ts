import {
  ensurePrincipal,
  revokePrincipal,
  setPrincipalPodIp,
  validateProfileDefinition,
} from "@pi-durable-k8s/session-core";
import type { SessionRow } from "@pi-durable-k8s/session-core";
import type pg from "pg";
import { Redacted } from "./onecli.js";

/**
 * The egress proxy side of a session (docs/decisions/0036-egress-principals.md). With the proxy enabled, every plain
 * session gets a principal in `egress.principals` (the hash of its egress token, the rule sets of its profile as they
 * were when it was created, its sandbox Pod's address) and its tool commands get the proxy environment. Repo sessions
 * keep the OneCLI environment (`buildShellEnv`) until slice 5 puts OneCLI behind the proxy; `usesEgressProxy` is the one
 * place that says which sessions those are.
 */

/** Slice 5 changes this: a repo session then goes through the proxy too, which chains OneCLI behind it. */
export function usesEgressProxy(session: Pick<SessionRow, "repo">): boolean {
  return session.repo === null;
}

const NO_PROXY = "localhost,127.0.0.1,::1";

/**
 * The environment of a plain session's tool commands (pi-env `shellEnv`). The proxy answers CONNECT only, so a client
 * must use https (or an http client that tunnels); `proxyAuthMethod=basic` makes git send the credentials at once.
 * `NODE_USE_ENV_PROXY` makes Node's fetch honour the variables. The token is the password of the proxy URL, readable
 * by the agent like the OneCLI token of a repo session: what bounds it is the session's rules, the Pod address it is
 * bound to and its revocation at deletion.
 */
export function buildEgressEnv(input: { proxy: string; token: Redacted }): Record<string, string> {
  const url = new URL(input.proxy);
  url.username = "x";
  url.password = input.token.reveal();
  const proxyUrl = url.toString().replace(/\/$/, "");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: NO_PROXY,
    no_proxy: NO_PROXY,
    NODE_USE_ENV_PROXY: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.proxyAuthMethod",
    GIT_CONFIG_VALUE_0: "basic",
  };
}

export interface EgressPrincipalsDeps {
  pool: Pick<pg.Pool, "query">;
  /** `http://host:port` of the proxy Service. */
  proxyUrl: string;
  /** The orchestrator's master key (the one sandbox tokens derive from). */
  master: () => string;
  now?: () => number;
}

/** A Pod's address is re-read at most this often by `beforeUse`, so a tool call costs no Kubernetes read most times. */
export const POD_IP_RECHECK_MS = 10_000;

export class EgressPrincipals {
  readonly #deps: EgressPrincipalsDeps;
  readonly #recorded = new Map<string, { ip: string | undefined; checkedAt: number }>();

  constructor(deps: EgressPrincipalsDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  async #token(session: SessionRow): Promise<Redacted | undefined> {
    const stored = session.profile;
    // A snapshot that does not validate gives no rule sets (only those that apply to all): fail closed, not open.
    const definition = stored === null ? {} : validateProfileDefinition(stored.snapshot);
    const ruleSets = typeof definition === "string" ? [] : (definition.egressRuleSets ?? []);
    const principal = await ensurePrincipal(
      this.#deps.pool,
      {
        sessionId: session.id,
        profile: stored === null ? null : { name: stored.name, version: stored.version },
        ruleSets,
      },
      this.#deps.master(),
    );
    return principal === undefined ? undefined : new Redacted(principal.token);
  }

  /**
   * The sandbox is attached: make sure the principal exists and records the Pod's address, before the first command
   * can send anything. A session that does not use the proxy, or whose principal is revoked, is left alone.
   */
  async attached(session: SessionRow, podIp: string | undefined): Promise<void> {
    if (!usesEgressProxy(session)) return;
    if ((await this.#token(session)) === undefined) return;
    await this.#record(session.id, podIp);
  }

  async #record(sessionId: string, podIp: string | undefined): Promise<void> {
    await setPrincipalPodIp(this.#deps.pool, sessionId, podIp ?? null);
    this.#recorded.set(sessionId, { ip: podIp, checkedAt: this.#now() });
  }

  /** The `shellEnv` of a plain session; undefined for a session the proxy does not serve or a revoked principal. */
  async shellEnv(session: SessionRow): Promise<Record<string, string> | undefined> {
    if (!usesEgressProxy(session) || session.status === "deleted" || session.status === "deleting")
      return undefined;
    const token = await this.#token(session);
    return token === undefined ? undefined : buildEgressEnv({ proxy: this.#deps.proxyUrl, token });
  }

  /**
   * Before a tool call on an open env: a Pod that was replaced behind the env (a crash, an eviction) has a new address,
   * and the token works only from the recorded one. Re-reads the address at most every `POD_IP_RECHECK_MS`.
   */
  async beforeUse(session: SessionRow, readIp: () => Promise<string | undefined>): Promise<void> {
    if (!usesEgressProxy(session)) return;
    const seen = this.#recorded.get(session.id);
    if (seen === undefined || this.#now() - seen.checkedAt < POD_IP_RECHECK_MS) return;
    const ip = await readIp();
    if (ip !== seen.ip) await this.#record(session.id, ip);
    else seen.checkedAt = this.#now();
  }

  /** Session deletion: the token is refused by the proxy from the next notification on. Idempotent. */
  async revoke(sessionId: string): Promise<void> {
    this.#recorded.delete(sessionId);
    await revokePrincipal(this.#deps.pool, sessionId);
  }
}
