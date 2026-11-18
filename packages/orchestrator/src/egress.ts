import dns from "node:dns/promises";
import net from "node:net";
import {
  boundSessions,
  deleteBinding,
  ensurePrincipal,
  ensureSessionOneCliRules,
  livePrincipalSessions,
  putBinding,
  readProxyStatus,
  removeSessionRules,
  revokePrincipal,
  sessionsWithRules,
  setPrincipalPodIp,
  validateProfileDefinition,
} from "@pi-durable-k8s/session-core";
import type { SessionRow } from "@pi-durable-k8s/session-core";
import type pg from "pg";
import { log } from "./log.js";
import { Redacted } from "./onecli.js";

/**
 * The egress proxy side of a session (docs/decisions/0036-egress-principals.md, 0037-egress-onecli-route.md). With the
 * proxy enabled, every session, repo sessions included, gets a principal in `egress.principals` (the hash of its egress
 * token, the rule sets of its profile as they were when it was created, its sandbox Pod's address) and its tool commands
 * get the proxy environment. A repo session also gets a binding (its OneCLI agent token, sealed for the proxy) and
 * session rules that send `github.com` through OneCLI; the sandbox holds the egress token only.
 */

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
  pool: pg.Pool;
  /**
   * Seals the OneCLI tokens of `egress.bindings` (the Secret the proxy mounts too). Undefined: no binding can be
   * written, so a repo session is refused rather than run without its credential.
   */
  bindingKey?: Buffer | undefined;
  /**
   * `http://host:port` of the proxy Service. A proxied sandbox has no DNS (ADR 0038), so the environment carries the
   * address this name resolves to, looked up here, where DNS works.
   */
  proxyUrl: string;
  /** One IPv4 address of a host name; only tests change this. */
  resolve?: (host: string) => Promise<string | undefined>;
  /** The orchestrator's master key (the one sandbox tokens derive from). */
  master: () => string;
  now?: () => number;
  /** Only tests change this. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long the address of the proxy Service is kept: a ClusterIP lives as long as the Service, this only bounds a stale one. */
export const PROXY_ADDRESS_TTL_MS = 60_000;

async function lookupIpv4(host: string): Promise<string | undefined> {
  try {
    return (await dns.lookup(host, { family: 4 })).address;
  } catch {
    return undefined;
  }
}

/** The longest a session waits for the proxies to serve a rule it just created. */
export const PROPAGATION_WAIT_MS = 10_000;

/** A Pod's address is re-read at most this often by `beforeUse`, so a tool call costs no Kubernetes read most times. */
export const POD_IP_RECHECK_MS = 10_000;

export class EgressPrincipals {
  readonly #deps: EgressPrincipalsDeps;
  readonly #recorded = new Map<string, { ip: string | undefined; checkedAt: number }>();
  /** The OneCLI token last sealed for each session by this process. */
  readonly #bound = new Map<string, string>();
  #proxyAddress: { url: string; until: number } | undefined;

  constructor(deps: EgressPrincipalsDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /**
   * The proxy URL a sandbox is given: the Service's address instead of its name, because a proxied sandbox cannot resolve
   * names. A name that does not resolve fails the call (a sandbox with a proxy it cannot reach has no network at all).
   */
  async #proxyForSandbox(): Promise<string> {
    const cached = this.#proxyAddress;
    if (cached !== undefined && cached.until > this.#now()) return cached.url;
    const url = new URL(this.#deps.proxyUrl);
    if (net.isIP(url.hostname) === 0) {
      const ip = await (this.#deps.resolve ?? lookupIpv4)(url.hostname);
      if (ip === undefined) throw new Error(`the egress proxy ${url.hostname} does not resolve`);
      url.hostname = ip;
    }
    const resolved = url.toString().replace(/\/$/, "");
    this.#proxyAddress = { url: resolved, until: this.#now() + PROXY_ADDRESS_TTL_MS };
    return resolved;
  }

  async #token(session: SessionRow): Promise<Redacted | undefined> {
    // A direct session has no proxy path: no principal, no token, no proxy environment (ADR 0038).
    if (session.networkMode === "direct") return undefined;
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
    if ((await this.#token(session)) === undefined) return;
    await this.#record(session.id, podIp);
  }

  async #record(sessionId: string, podIp: string | undefined): Promise<void> {
    await setPrincipalPodIp(this.#deps.pool, sessionId, podIp ?? null);
    this.#recorded.set(sessionId, { ip: podIp, checkedAt: this.#now() });
  }

  /** The proxy environment of a session; undefined for a session that is going away or whose principal is revoked. */
  async shellEnv(session: SessionRow): Promise<Record<string, string> | undefined> {
    if (session.status === "deleted" || session.status === "deleting") return undefined;
    const token = await this.#token(session);
    return token === undefined
      ? undefined
      : buildEgressEnv({ proxy: await this.#proxyForSandbox(), token });
  }

  /**
   * Before a tool call on an open env: a Pod that was replaced behind the env (a crash, an eviction) has a new address,
   * and the token works only from the recorded one. Re-reads the address at most every `POD_IP_RECHECK_MS`.
   */
  async beforeUse(session: SessionRow, readIp: () => Promise<string | undefined>): Promise<void> {
    const seen = this.#recorded.get(session.id);
    if (seen === undefined || this.#now() - seen.checkedAt < POD_IP_RECHECK_MS) return;
    const ip = await readIp();
    if (ip !== seen.ip) await this.#record(session.id, ip);
    else seen.checkedAt = this.#now();
  }

  /** Whether a OneCLI binding can be written (the sealing key is configured). */
  canBind(): boolean {
    return this.#deps.bindingKey !== undefined;
  }

  /**
   * A repo session's OneCLI agent is ready: seal its token for the proxy and make `route=onecli` apply to the hosts
   * where OneCLI injects its credential. The binding goes first and the rules last: a rule bumps the rules revision, and
   * once every proxy replica reports that revision it has read the binding too (one statement reads both), so the
   * session's first call cannot reach the route before the binding is there. Writes only what changed: the same token
   * is not sealed again in this process, existing rules are not recreated.
   */
  async bindOneCli(session: SessionRow, token: Redacted, hosts: readonly string[]): Promise<void> {
    const key = this.#deps.bindingKey;
    if (key === undefined) throw new Error("the egress binding key is not configured");
    const revealed = token.reveal();
    if (this.#bound.get(session.id) !== revealed) {
      await putBinding(this.#deps.pool, key, session.id, revealed);
      this.#bound.set(session.id, revealed);
    }
    const revision = await ensureSessionOneCliRules(this.#deps.pool, session.id, hosts);
    if (revision !== undefined) await this.#awaitProxies(revision, session.id);
  }

  /** Waits (bounded) until every serving proxy replica has read at least `revision`; a missing replica never blocks. */
  async #awaitProxies(revision: number, sessionId: string): Promise<void> {
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const start = this.#now();
    for (;;) {
      const serving = (await readProxyStatus(this.#deps.pool)).filter((r) => r.state === "serving");
      if (serving.every((r) => r.revision !== null && r.revision >= revision)) return;
      if (this.#now() - start >= PROPAGATION_WAIT_MS) {
        log("egress-propagation-timeout", { session: sessionId, revision });
        return;
      }
      await sleep(200);
    }
  }

  /**
   * Session deletion (and the orphan sweep): the egress token is refused by the proxy from the next notification on
   * (well under 10 s), and the session's binding and session rules are gone. The principal goes first, since a dead
   * token already ends everything; each step is idempotent, so a retry finishes what a failure left. Open tunnels are
   * not closed (slice 7).
   */
  async revoke(sessionId: string): Promise<void> {
    this.#recorded.delete(sessionId);
    this.#bound.delete(sessionId);
    await revokePrincipal(this.#deps.pool, sessionId);
    await deleteBinding(this.#deps.pool, sessionId);
    await removeSessionRules(this.#deps.pool, sessionId);
  }

  /** Session ids that still hold anything at the proxy (a live principal, a binding, a session rule): the sweep's input. */
  async live(): Promise<string[]> {
    const [principals, bound, ruled] = await Promise.all([
      livePrincipalSessions(this.#deps.pool),
      boundSessions(this.#deps.pool),
      sessionsWithRules(this.#deps.pool),
    ]);
    return [...new Set([...principals, ...bound, ...ruled])].sort();
  }
}
