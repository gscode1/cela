import { readFile } from "node:fs/promises";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { isUntrustedContentFlavour, validateProfileDefinition } from "@cela/session-core";
import type { McpServerConfig, ProfileDefinition, SessionRow } from "@cela/session-core";
import { log } from "./log.js";
import type { OneCliAdmin } from "./onecli-admin.js";
import { narrowAgent } from "./onecli-grants.js";
import {
  DEFAULT_ONECLI_NAME_PREFIX,
  ONECLI_IDENTIFIER_MAX,
  ONECLI_NAME_PREFIX_MAX,
  mcpAgentIdentifier,
  mcpDiscoveryPrefix,
  validateNamePrefix,
} from "./onecli-names.js";
import { createGatewayFetch, Redacted } from "./onecli.js";
import type { GatewayFetch } from "./onecli.js";
import { hostPatternMatches } from "./providers.js";

/**
 * The OneCLI identity of the orchestrator's credentialed MCP calls (docs/decisions/0040-mcp-egress-flow.md, issue #42).
 * A session's calls to a catalog server that names a OneCLI secret go through the gateway as that session's own agent,
 * `<prefix><session id>-m`, whose only grants are the secrets of the credentialed servers its profile names
 * (`mcpServers`, read from the session's profile snapshot, never from the catalog alone). Another session's calls carry
 * another agent's token, so one session cannot use the credential another was granted, and a profile that does not name a
 * server gets no grant and no way to ask for one. Credentials stay in OneCLI: the secret is an operator's, referenced by
 * name (`onecliSecret`), and this class only grants it.
 *
 * Tool discovery has no session. A credentialed server's `tools/list` goes through a discovery agent of its own,
 * `<prefix>d-<server>`, granted that one secret and used for nothing else (the calls never use it).
 *
 * Servers without a secret keep the orchestrator-wide gateway token: nothing there is session-specific.
 */

export class McpNotGrantedError extends Error {}

export interface McpAccessDeps {
  /** Undefined when `ONECLI_API_KEY` is not set: a credentialed server is then unavailable, not open. */
  onecli: OneCliAdmin | undefined;
  /** The catalog as it is now (every row). */
  catalog: () => readonly McpServerConfig[];
  sessionOf: (conversationId: number) => Promise<SessionRow | undefined>;
  gateway: string;
  caFile: string;
  noProxy: readonly string[];
  namePrefix?: string | undefined;
  /** Only tests change these. */
  readCa?: (path: string) => Promise<string>;
  makeFetch?: (token: Redacted) => Promise<GatewayFetch>;
}

interface Identity {
  signature: string;
  agentId: string;
  token: Redacted;
  fetch: GatewayFetch;
  /** What the MCP transport holds: it follows the agent when it is replaced, and fails once the identity is revoked. */
  stable: McpFetch;
  revoked: boolean;
}

export class McpAccess {
  readonly #deps: McpAccessDeps;
  readonly #prefix: string;
  readonly #sessions = new Map<string, Identity>();
  readonly #discovery = new Map<string, Identity>();
  readonly #inFlight = new Map<string, Promise<Identity>>();

  constructor(deps: McpAccessDeps) {
    this.#deps = deps;
    this.#prefix = validateNamePrefix(deps.namePrefix ?? DEFAULT_ONECLI_NAME_PREFIX);
  }

  /** The MCP servers a session's profile names, from its snapshot; none for a session without a valid one. */
  #named(session: SessionRow): string[] {
    return this.#definitionOf(session)?.mcpServers ?? [];
  }

  #definitionOf(session: SessionRow): ProfileDefinition | undefined {
    const stored = session.profile;
    if (stored === null) return undefined;
    const definition = validateProfileDefinition(stored.snapshot);
    return typeof definition === "string" ? undefined : definition;
  }

  /**
   * The enabled, credentialed servers of the catalog that the session's profile names. A browser, desktop or direct session
   * gets none, whatever the catalog says now (ADR 0041, 0065, 0038): the catalog may have changed since the session started.
   */
  credentialedFor(session: SessionRow): McpServerConfig[] {
    const definition = this.#definitionOf(session);
    if (
      isUntrustedContentFlavour(definition?.sandboxFlavour) ||
      definition?.networkMode === "direct"
    )
      return [];
    const named = new Set(this.#named(session));
    return this.#deps
      .catalog()
      .filter((spec) => spec.enabled && spec.onecliSecret !== null && named.has(spec.name));
  }

  async #makeFetch(token: Redacted): Promise<GatewayFetch> {
    if (this.#deps.makeFetch !== undefined) return this.#deps.makeFetch(token);
    const ca = await (this.#deps.readCa ?? ((path) => readFile(path, "utf8")))(this.#deps.caFile);
    return createGatewayFetch({
      gateway: this.#deps.gateway,
      token,
      ca,
      noProxy: this.#deps.noProxy,
    });
  }

  /** The ids of the OneCLI secrets the servers name; a secret that is missing or is for another host is refused. */
  async #secretIds(onecli: OneCliAdmin, servers: readonly McpServerConfig[]): Promise<string[]> {
    const known = await onecli.listSecrets();
    const ids: string[] = [];
    for (const server of servers) {
      const secret = known.find((entry) => entry.name === server.onecliSecret);
      if (secret === undefined) {
        throw new McpNotGrantedError(
          `MCP server ${server.name}: the OneCLI secret "${server.onecliSecret ?? ""}" does not exist`,
        );
      }
      const host = new URL(server.url).hostname;
      // A secret for another host would never be injected into this server's requests: a catalog row that points at the
      // wrong secret is a mistake to report, not a grant to hand out.
      if (secret.hostPattern !== undefined && !hostPatternMatches(secret.hostPattern, host)) {
        throw new McpNotGrantedError(
          `MCP server ${server.name}: the OneCLI secret "${secret.name}" is for ${secret.hostPattern}, not ${host}`,
        );
      }
      ids.push(secret.id);
    }
    return ids;
  }

  /** Agent, narrow grants and a fetch for `identifier`; reuses the cached identity while its signature holds. */
  async #identity(
    cache: Map<string, Identity>,
    key: string,
    identifier: string,
    servers: readonly McpServerConfig[],
    what: string,
  ): Promise<Identity> {
    const signature = servers.map((s) => `${s.name}=${s.onecliSecret ?? ""}`).join(",");
    const cached = cache.get(key);
    if (cached !== undefined && !cached.revoked && cached.signature === signature) return cached;
    const { onecli } = this.#deps;
    if (onecli === undefined) {
      throw new McpNotGrantedError(
        "credentialed MCP servers need the OneCLI admin key: ONECLI_API_KEY is not set",
      );
    }
    if (identifier.length > ONECLI_IDENTIFIER_MAX) {
      throw new McpNotGrantedError(
        `the OneCLI agent name ${identifier} is longer than ${String(ONECLI_IDENTIFIER_MAX)} characters: PI_ONECLI_NAME_PREFIX is too long for MCP agents (at most ${String(ONECLI_NAME_PREFIX_MAX)} characters)`,
      );
    }
    const secretIds = await this.#secretIds(onecli, servers);
    const { agent, created } = await onecli.ensureAgent(identifier);
    try {
      await narrowAgent(onecli, agent.id, secretIds, what);
    } catch (error) {
      // An agent that might hold more than it should must not outlive the failed attempt.
      await onecli.deleteAgent(agent.id).catch(() => undefined);
      throw error;
    }
    if (cached !== undefined && !cached.revoked) {
      // The same agent (its grants were just proven): only the signature moves. A replaced agent keeps the identity
      // object, since the MCP transports hold its `stable` fetch, which then follows the new token.
      cached.signature = signature;
      if (cached.token.reveal() === agent.accessToken.reveal()) return cached;
      const old = cached.fetch;
      cached.fetch = await this.#makeFetch(agent.accessToken);
      cached.token = agent.accessToken;
      cached.agentId = agent.id;
      await old.close().catch(() => undefined);
      return cached;
    }
    const fetch = await this.#makeFetch(agent.accessToken);
    const identity: Identity = {
      signature,
      agentId: agent.id,
      token: agent.accessToken,
      fetch,
      revoked: false,
      stable: (input, init) =>
        identity.revoked
          ? Promise.reject(new McpNotGrantedError("the MCP identity was revoked"))
          : identity.fetch(input, init),
    };
    cache.set(key, identity);
    log("mcp-identity-ready", { agent: identifier, servers: servers.map((s) => s.name), created });
    return identity;
  }

  /**
   * The `fetch` that carries `conversationId`'s session's grants to `spec`, provisioning its agent first. Rejects with
   * `McpNotGrantedError` when the session is gone or its profile does not name the server: no grant, no call.
   */
  async forConversation(conversationId: number, spec: McpServerConfig): Promise<McpFetch> {
    const session = await this.#deps.sessionOf(conversationId);
    if (session === undefined || session.status === "deleted" || session.status === "deleting") {
      throw new McpNotGrantedError("the session is gone");
    }
    if (!this.#named(session).includes(spec.name)) {
      throw new McpNotGrantedError(`the session's profile does not name MCP server ${spec.name}`);
    }
    const servers = this.credentialedFor(session);
    if (!servers.some((server) => server.name === spec.name)) {
      throw new McpNotGrantedError(`MCP server ${spec.name} is not a credentialed server now`);
    }
    return (await this.#ensure(session, servers)).stable;
  }

  /** One provisioning at a time per session, so concurrent calls share the agent. */
  #ensure(session: SessionRow, servers: readonly McpServerConfig[]): Promise<Identity> {
    let running = this.#inFlight.get(session.id);
    if (running === undefined) {
      running = this.#identity(
        this.#sessions,
        session.id,
        mcpAgentIdentifier(session.id, this.#prefix),
        servers,
        "the credentialed MCP secrets of the session's profile",
      ).finally(() => this.#inFlight.delete(session.id));
      this.#inFlight.set(session.id, running);
    }
    return running;
  }

  /**
   * Before the session's first turn: creates its agent and proves the grants (see `forConversation`). A session whose
   * profile names no credentialed server holds nothing and makes no OneCLI call.
   */
  async provision(session: SessionRow): Promise<void> {
    const servers = this.credentialedFor(session);
    if (servers.length === 0) return;
    await this.#ensure(session, servers);
  }

  /** The `fetch` for listing the tools of a credentialed server (its own agent, its one secret). */
  async discovery(spec: McpServerConfig): Promise<McpFetch> {
    const identity = await this.#identity(
      this.#discovery,
      spec.name,
      `${mcpDiscoveryPrefix(this.#prefix)}${spec.name}`,
      [spec],
      `the OneCLI secret of MCP server ${spec.name}`,
    );
    return identity.stable;
  }

  /**
   * Session deletion: the session's MCP agent is deleted (its token fails at once) and its fetch closed. A session whose
   * profile names no MCP server holds nothing and makes no OneCLI call. Idempotent.
   */
  async teardown(session: SessionRow): Promise<void> {
    if (this.#named(session).length === 0 && !this.#sessions.has(session.id)) return;
    await this.revokeSession(session.id);
  }

  /** Revokes whatever MCP identity this session id holds, found by name (the orphan sweep has no session row). */
  async revokeSession(sessionId: string): Promise<void> {
    const identity = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (identity !== undefined) {
      identity.revoked = true;
      await identity.fetch.close().catch(() => undefined);
    }
    const { onecli } = this.#deps;
    if (onecli === undefined) return;
    const identifier = mcpAgentIdentifier(sessionId, this.#prefix);
    for (const agent of await onecli.listAgents()) {
      if (agent.identifier === identifier) await onecli.deleteAgent(agent.id);
    }
  }

  /**
   * After a catalog change: a discovery agent whose server is gone, disabled or no longer credentialed is deleted, so no
   * agent keeps a credential nobody asks for. Best effort; the next change tries again.
   */
  async reconcileDiscovery(catalog: readonly McpServerConfig[]): Promise<void> {
    const { onecli } = this.#deps;
    if (onecli === undefined) return;
    const live = new Set(
      catalog.filter((s) => s.enabled && s.onecliSecret !== null).map((s) => s.name),
    );
    const prefix = mcpDiscoveryPrefix(this.#prefix);
    for (const agent of await onecli.listAgents()) {
      if (!agent.identifier.startsWith(prefix)) continue;
      const server = agent.identifier.slice(prefix.length);
      if (live.has(server)) continue;
      const cached = this.#discovery.get(server);
      this.#discovery.delete(server);
      if (cached !== undefined) {
        cached.revoked = true;
        await cached.fetch.close().catch(() => undefined);
      }
      await onecli.deleteAgent(agent.id);
      log("mcp-discovery-agent-removed", { server });
    }
  }

  /** Closes every dispatcher (shutdown). The agents stay: they are revoked with their sessions. */
  async close(): Promise<void> {
    const all = [...this.#sessions.values(), ...this.#discovery.values()];
    this.#sessions.clear();
    this.#discovery.clear();
    await Promise.all(all.map((identity) => identity.fetch.close().catch(() => undefined)));
  }
}
