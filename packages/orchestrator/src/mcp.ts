import {
  createMcpToolName,
  limitMcpContent,
  McpClient,
  McpSessionExpiredError,
  normalizeMcpInputSchema,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { CallToolResult, McpFetch, McpTransport, Tool } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { mcpServersEqual } from "@pi-durable-k8s/session-core";
import type { McpServerConfig } from "@pi-durable-k8s/session-core";
import { errorMessage, log } from "./log.js";

/**
 * Native remote MCP tools (docs/decisions/0007-native-remote-mcp.md). The orchestrator is the MCP client: its HTTP
 * requests go through the OneCLI gateway like the model calls, and nothing runs in or reaches into the sandbox. The
 * servers come from the catalog in Postgres and change at runtime (docs/decisions/0009-mcp-catalog-in-postgres.md).
 */

/** One enabled row of the catalog (`inbox.mcp_servers`, docs/decisions/0009-mcp-catalog-in-postgres.md). */
export type McpServerSpec = McpServerConfig;

export interface McpTimings {
  /** One `connect` plus `listTools` attempt. */
  discoveryTimeoutMs: number;
  /** Backoff between failed discovery attempts: starts at `retryMinMs`, doubles up to `retryMaxMs`. */
  retryMinMs: number;
  retryMaxMs: number;
}

export const DEFAULT_MCP_TIMINGS: McpTimings = {
  discoveryTimeoutMs: 15_000,
  retryMinMs: 2_000,
  retryMaxMs: 60_000,
};

/** Largest JSON-RPC message a transport accepts. pi-mcp defaults to 16 MiB; one call would hold that in memory. */
export const MCP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** What the model is given of one result, on top of `limitMcpContent` (20 KB of text, middle cut): the row's `maxOutputBytes`. */
const outputLimits = (maxBytes: number) => ({ maxBytes, maxLines: 2000, retain: "head" }) as const;

/** JSON with sorted keys, so two schemas that differ only in key order compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `fetch` replaces the factory's own: the identity of a credentialed server's session (or its discovery). */
export type McpTransportFactory = (spec: McpServerSpec, fetch?: McpFetch) => McpTransport;

/**
 * Whose grants a credentialed server's requests carry (docs/decisions/0040-mcp-egress-flow.md): a session's own, from its
 * profile, and for tool discovery the server's discovery agent. Servers without a secret use the factory's fetch.
 */
export interface McpIdentity {
  /** The fetch for `tools/list` of a credentialed server. */
  discovery(spec: McpServerSpec): Promise<McpFetch>;
  /** The fetch carrying the grants of the conversation's session; rejects when it has none for this server. */
  forConversation(conversationId: number, spec: McpServerSpec): Promise<McpFetch>;
}

/**
 * A redirect fails the request instead of being followed. The gateway may reach private addresses
 * (docs/decisions/0043-open-onecli-defaults.md) and an admin vetted the server's URL, not wherever that server points
 * next, so a 30x must not carry our request, or a credential the gateway injects, to another host. Only the MCP
 * transport is bound by this: model calls share the gateway fetch and keep its default.
 */
export function refuseRedirects(fetch: McpFetch): McpFetch {
  return (input, init) => fetch(input, { ...init, redirect: "error" });
}

/** The production transport: streamable HTTP through `fetch` (the gateway), no server-to-client stream, no redirects. */
export function httpTransportFactory(fetch: McpFetch): McpTransportFactory {
  return (spec, override) =>
    new StreamableHttpTransport({
      url: spec.url,
      fetch: refuseRedirects(override ?? fetch),
      openGetStream: false,
      maxMessageBytes: MCP_MAX_MESSAGE_BYTES,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects after `ms`; `onTimeout` runs first so the pending work can be cut off. */
async function bounded<T>(work: Promise<T>, ms: number, what: string, onTimeout: () => void) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects after `ms` without cancelling `work`, which others may share. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return bounded(work, ms, what, () => undefined);
}

/**
 * One connection to one server: connect on demand (one connect at a time, shared by every caller that needs it), drop on
 * a failure, close on retirement. A server has one for discovery and for servers without a secret, and one per
 * conversation for a credentialed server, so no request of one session ever travels on another session's identity.
 */
class McpConnection {
  readonly #name: string;
  readonly #requestTimeoutMs: number;
  readonly #timeoutMs: number;
  readonly #transport: () => Promise<McpTransport>;
  /** The connect in progress, shared by every caller that needs a connection meanwhile. */
  #connecting: Promise<McpClient> | undefined;
  #ready: McpClient | undefined;

  constructor(
    name: string,
    requestTimeoutMs: number,
    discoveryTimeoutMs: number,
    transport: () => Promise<McpTransport>,
  ) {
    this.#name = name;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#timeoutMs = discoveryTimeoutMs;
    this.#transport = transport;
  }

  async #connect(): Promise<McpClient> {
    const client = new McpClient({
      name: "pi-durable-k8s",
      version: "0.0.0",
      requestTimeoutMs: this.#requestTimeoutMs,
    });
    // A dropped connection or an expired session makes the next use connect again.
    client.onClose(() => {
      if (this.#ready === client) this.#ready = undefined;
    });
    await bounded(
      this.#transport().then((transport) => client.connect(transport)),
      this.#timeoutMs,
      `mcp ${this.#name} connect`,
      () => void client.close().catch(() => undefined),
    ).catch(async (error: unknown) => {
      await client.close().catch(() => undefined);
      throw error;
    });
    this.#ready = client;
    return client;
  }

  connected(): Promise<McpClient> {
    if (this.#ready !== undefined && this.#ready.connectionState === "connected") {
      return Promise.resolve(this.#ready);
    }
    // One connect at a time: concurrent callers after a drop share it instead of each opening (and leaking) a client.
    if (this.#connecting !== undefined) return this.#connecting;
    const connecting = this.#connect();
    this.#connecting = connecting;
    const clear = () => {
      if (this.#connecting === connecting) this.#connecting = undefined;
    };
    connecting.then(clear, clear);
    return connecting;
  }

  async drop(client: McpClient): Promise<void> {
    if (this.#ready === client) this.#ready = undefined;
    await client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const pending = await this.#connecting?.catch(() => undefined);
    const client = this.#ready ?? pending;
    this.#connecting = undefined;
    this.#ready = undefined;
    await client?.close().catch(() => undefined);
  }
}

/** Conversations whose credentialed connections one server keeps; the least recently used is closed past it. */
const MAX_SESSION_CONNECTIONS = 256;

/**
 * One server: one shared `McpClient` (so the server must be stateless across conversations), and one extension
 * `mcp-<name>` of deferred tools. The extension is installed empty at once and replaced when discovery succeeds;
 * until then a call to one of its tools settles as Pi Durable's `tool_unavailable`.
 */
export class McpServer {
  readonly extensionName: string;
  readonly spec: McpServerSpec;
  /** The extension as installed now: empty until discovery succeeded. */
  extension: Extension;
  readonly #spec: McpServerSpec;
  /** Input schema of every tool of the last discovery, canonical JSON by tool name. */
  readonly #schemas = new Map<string, string>();
  /** The schemas of the server this one replaces: a change between the two versions is logged. */
  readonly #previousSchemas: ReadonlyMap<string, string>;
  /** `callTool`s that started and have not settled: a retired server is closed only after they finish. */
  #inFlight = 0;
  #retired = false;
  #drained: (() => void) | undefined;
  readonly #transport: McpTransportFactory;
  readonly #timings: McpTimings;
  readonly #registry: Registry;
  readonly #stop = new AbortController();
  readonly #identity: McpIdentity | undefined;
  /** Discovery's connection, and the calls' for a server without a secret: the orchestrator-wide gateway token. */
  readonly #shared: McpConnection;
  /**
   * A credentialed server's calls, one connection per conversation, each on its session's own grants. Least recently
   * used last in insertion order; at most `MAX_SESSION_CONNECTIONS`.
   */
  readonly #sessions = new Map<number, McpConnection>();
  #discovery: Promise<void> | undefined;
  /** Wakes the discovery's wait between two attempts (`nudge`). */
  #wake: (() => void) | undefined;

  constructor(
    spec: McpServerSpec,
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings,
    previousSchemas: ReadonlyMap<string, string> = new Map(),
    identity?: McpIdentity,
  ) {
    this.#identity = identity;
    this.#shared = new McpConnection(
      spec.name,
      spec.timeoutMs,
      timings.discoveryTimeoutMs,
      async () => {
        if (spec.onecliSecret === null) return transport(spec);
        if (identity === undefined) {
          throw new Error(
            `MCP server ${spec.name} needs a credential, but no MCP identity is configured`,
          );
        }
        return transport(spec, await identity.discovery(spec));
      },
    );
    this.spec = spec;
    this.#spec = spec;
    this.#previousSchemas = previousSchemas;
    this.#registry = registry;
    this.#transport = transport;
    this.#timings = timings;
    this.extensionName = `mcp-${spec.name}`;
    this.extension = defineExtension({ name: this.extensionName, tools: [] });
    registry.install(this.extension);
  }

  /** Starts discovery in the background. Never throws and never blocks: a server that is down only delays its tools. */
  start(): void {
    this.#discovery ??= this.#discover();
  }

  /** The input schemas this server last listed, for the server that replaces it. */
  get schemas(): ReadonlyMap<string, string> {
    return this.#schemas;
  }

  /**
   * The server left the catalog (or is replaced): discovery stops now, calls that already started finish, and then the
   * connection is closed. A call that starts afterwards (from a conversation that still held the tool) fails at once.
   */
  async retire(): Promise<void> {
    this.#retired = true;
    this.#stop.abort();
    if (this.#inFlight > 0) {
      await new Promise<void>((resolve) => {
        this.#drained = resolve;
      });
    }
    await this.close();
  }

  /** Stops discovery and closes the connections, ending calls that are still running (shutdown). */
  async close(): Promise<void> {
    this.#stop.abort();
    await this.#discovery;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all([this.#shared.close(), ...sessions.map((connection) => connection.close())]);
  }

  /** Cuts the wait before the next discovery attempt (a host rule was just opened): the next try is now, not in seconds. */
  nudge(): void {
    this.#wake?.();
  }

  /** The connection for a call: the shared one, or the conversation's own for a credentialed server. */
  #connectionFor(conversationId: number): McpConnection {
    if (this.#spec.onecliSecret === null) return this.#shared;
    const known = this.#sessions.get(conversationId);
    if (known !== undefined) {
      this.#sessions.delete(conversationId);
      this.#sessions.set(conversationId, known);
      return known;
    }
    const identity = this.#identity;
    const connection = new McpConnection(
      this.#spec.name,
      this.#spec.timeoutMs,
      this.#timings.discoveryTimeoutMs,
      async () => {
        // No identity, no call: a credentialed server is never reached on the orchestrator's own token.
        if (identity === undefined) {
          throw new Error(
            `MCP server ${this.#spec.name} needs a credential, but no MCP identity is configured`,
          );
        }
        return this.#transport(
          this.#spec,
          await identity.forConversation(conversationId, this.#spec),
        );
      },
    );
    this.#sessions.set(conversationId, connection);
    if (this.#sessions.size > MAX_SESSION_CONNECTIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.#sessions.get(oldest);
        this.#sessions.delete(oldest);
        void evicted?.close();
      }
    }
    return connection;
  }

  async #listTools(): Promise<Tool[]> {
    const client = await this.#shared.connected();
    try {
      return await client.listTools({ timeoutMs: this.#timings.discoveryTimeoutMs });
    } catch (error) {
      await this.#shared.drop(client);
      throw error;
    }
  }

  /** A method, not a repeated `signal.aborted`: the flag can flip during an await, which flow analysis cannot see. */
  #stopped(): boolean {
    return this.#stop.signal.aborted;
  }

  /** Waits `ms`, or until close. The abort listener is removed when the timer fires, so retries do not pile them up. */
  #sleep(ms: number): Promise<void> {
    const signal = this.#stop.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  async #discover(): Promise<void> {
    let delay = this.#timings.retryMinMs;
    while (!this.#stopped()) {
      try {
        const tools = await this.#listTools();
        if (this.#stopped()) return;
        this.#noteSchemas(tools);
        this.extension = this.#buildExtension(tools);
        this.#registry.install(this.extension);
        log("mcp-tools-ready", { server: this.#spec.name, tools: tools.length });
        return;
      } catch (error) {
        log("mcp-discovery-failed", {
          server: this.#spec.name,
          message: errorMessage(error),
          retryMs: delay,
        });
        await this.#sleep(delay);
        delay = Math.min(delay * 2, this.#timings.retryMaxMs);
      }
    }
  }

  /** Records the schemas and logs each tool whose input schema differs from the version this server replaces. */
  #noteSchemas(tools: readonly Tool[]): void {
    this.#schemas.clear();
    for (const tool of tools) this.#schemas.set(tool.name, canonicalJson(tool.inputSchema));
    for (const [name, schema] of this.#schemas) {
      const before = this.#previousSchemas.get(name);
      if (before !== undefined && before !== schema) {
        log("mcp-schema-changed", { server: this.#spec.name, tool: name });
      }
    }
  }

  /** One `callTool`; after a session expiry it connects again and tries once more (the server refused it unrun). */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    conversationId: number,
  ): Promise<CallToolResult> {
    if (this.#retired) throw new Error(`MCP server ${this.#spec.name} is no longer available`);
    this.#inFlight += 1;
    // One budget for the whole call: waiting for a connection, the call itself and the retry after a session expiry.
    const deadline = Date.now() + this.#spec.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      for (let attempt = 0; ; attempt += 1) {
        // The connect may be shared with other callers, so only this call's wait for it is cut, not the connect.
        const connection = this.#connectionFor(conversationId);
        const client = await within(
          connection.connected(),
          remaining(),
          `mcp ${this.#spec.name} call (connect)`,
        );
        try {
          return await client.callTool(name, args, {
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: remaining(),
          });
        } catch (error) {
          if (error instanceof McpSessionExpiredError && attempt === 0) {
            await connection.drop(client);
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) this.#drained?.();
    }
  }

  #buildExtension(tools: readonly Tool[]): Extension {
    const taken = new Set<string>();
    const registrations: ToolRegistration[] = tools.map((tool) => {
      const name = createMcpToolName(this.#spec.name, tool.name, (candidate) =>
        taken.has(candidate),
      );
      taken.add(name);
      return defineTool<object>({
        name,
        description: tool.description ?? tool.title ?? tool.name,
        parameters: normalizeMcpInputSchema(tool.inputSchema),
        // A crashed call settles `interrupted` and is never rerun: the server may have acted on it.
        replay: "unsafe",
        // Offered only after the model found it with `tool_search`: a server can have dozens of tools.
        deferred: true,
        outputLimits: outputLimits(this.#spec.maxOutputBytes),
        execute: async (args, api, context) => {
          const result = await this.call(
            tool.name,
            isRecord(args) ? args : {},
            context.abortSignal,
            Number(api.conversationId),
          );
          const { content } = await limitMcpContent(toLlmContent(result));
          // Tool failures are results, not protocol errors: the model sees the text and an error mark.
          return { output: content, isError: result.isError === true };
        },
      });
    });
    return defineExtension({ name: this.extensionName, tools: registrations });
  }
}

/**
 * The catalog's enabled servers as installed extensions. `apply` makes the installed set match a catalog: a new server
 * is installed (empty until its tools are listed), a removed or disabled one is uninstalled so its tools settle
 * `tool_unavailable`, and a changed one is replaced by a new server with a new client. The server that goes away
 * finishes the calls it has and is then closed.
 */
export class McpTools {
  readonly #servers = new Map<string, McpServer>();
  readonly #registry: Registry;
  readonly #transport: McpTransportFactory;
  readonly #timings: McpTimings;
  readonly #retiring = new Map<McpServer, Promise<void>>();
  #running = false;
  #closed = false;

  readonly #identity: McpIdentity | undefined;

  constructor(
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings = DEFAULT_MCP_TIMINGS,
    identity?: McpIdentity,
  ) {
    this.#registry = registry;
    this.#transport = transport;
    this.#timings = timings;
    this.#identity = identity;
  }

  /** A host rule was just opened (or any change that may make a server reachable): every server retries its discovery now. */
  nudge(): void {
    for (const server of this.#servers.values()) server.nudge();
  }

  get servers(): readonly McpServer[] {
    return [...this.#servers.values()];
  }

  /** The extension of an enabled server as installed now (only the name is stored), or undefined. */
  extensionOf(name: string): Extension | undefined {
    return this.#servers.get(name)?.extension;
  }

  /** Makes the installed servers the enabled ones of `catalog`. Cheap when nothing changed. */
  apply(catalog: readonly McpServerConfig[]): void {
    if (this.#closed) return;
    const wanted = new Map(catalog.filter((spec) => spec.enabled).map((spec) => [spec.name, spec]));
    for (const [name, server] of [...this.#servers]) {
      if (wanted.has(name)) continue;
      this.#servers.delete(name);
      this.#registry.uninstall(server.extension);
      this.#retire(server);
      log("mcp-server-removed", { server: name });
    }
    for (const spec of wanted.values()) {
      const current = this.#servers.get(spec.name);
      if (current !== undefined && mcpServersEqual(current.spec, spec)) continue;
      // A new server installs its empty extension over the old one's by name, so a replaced server has no gap in the
      // registry; its tools are listed again, which is where a changed input schema shows up.
      const server = new McpServer(
        spec,
        this.#registry,
        this.#transport,
        this.#timings,
        current?.schemas,
        this.#identity,
      );
      this.#servers.set(spec.name, server);
      if (current !== undefined) this.#retire(current);
      log(current === undefined ? "mcp-server-added" : "mcp-server-replaced", {
        server: spec.name,
      });
      if (this.#running) server.start();
    }
  }

  #retire(server: McpServer): void {
    const retiring = server.retire().finally(() => this.#retiring.delete(server));
    this.#retiring.set(server, retiring);
  }

  /** Starts discovery of every server, and of every server added later. */
  start(): void {
    this.#running = true;
    for (const server of this.#servers.values()) server.start();
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Shutdown does not wait for calls that are still running: closing a client ends them.
    await Promise.all([
      ...this.servers.map((server) => server.close()),
      ...[...this.#retiring.keys()].map((server) => server.close()),
    ]);
    await Promise.all(this.#retiring.values());
  }
}
