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

export type McpTransportFactory = (spec: McpServerSpec) => McpTransport;

/** The production transport: streamable HTTP through `fetch` (the gateway), no server-to-client stream. */
export function httpTransportFactory(fetch: McpFetch): McpTransportFactory {
  return (spec) =>
    new StreamableHttpTransport({
      url: spec.url,
      fetch,
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
  /** The connect in progress, shared by every caller that needs a connection meanwhile. */
  #connecting: Promise<McpClient> | undefined;
  #ready: McpClient | undefined;
  #discovery: Promise<void> | undefined;

  constructor(
    spec: McpServerSpec,
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings,
    previousSchemas: ReadonlyMap<string, string> = new Map(),
  ) {
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

  /** Stops discovery and closes the connection, ending calls that are still running (shutdown). */
  async close(): Promise<void> {
    this.#stop.abort();
    await this.#discovery;
    const pending = await this.#connecting?.catch(() => undefined);
    const client = this.#ready ?? pending;
    this.#connecting = undefined;
    this.#ready = undefined;
    await client?.close().catch(() => undefined);
  }

  async #connect(): Promise<McpClient> {
    const client = new McpClient({
      name: "pi-durable-k8s",
      version: "0.0.0",
      requestTimeoutMs: this.#spec.timeoutMs,
    });
    // A dropped connection or an expired session makes the next use connect again.
    client.onClose(() => {
      if (this.#ready === client) this.#ready = undefined;
    });
    await bounded(
      client.connect(this.#transport(this.#spec)),
      this.#timings.discoveryTimeoutMs,
      `mcp ${this.#spec.name} connect`,
      () => void client.close().catch(() => undefined),
    ).catch(async (error: unknown) => {
      await client.close().catch(() => undefined);
      throw error;
    });
    this.#ready = client;
    return client;
  }

  #connected(): Promise<McpClient> {
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

  async #drop(client: McpClient): Promise<void> {
    if (this.#ready === client) this.#ready = undefined;
    await client.close().catch(() => undefined);
  }

  async #listTools(): Promise<Tool[]> {
    const client = await this.#connected();
    try {
      return await client.listTools({ timeoutMs: this.#timings.discoveryTimeoutMs });
    } catch (error) {
      await this.#drop(client);
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
        resolve();
      };
      const timer = setTimeout(done, ms);
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
  ): Promise<CallToolResult> {
    if (this.#retired) throw new Error(`MCP server ${this.#spec.name} is no longer available`);
    this.#inFlight += 1;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const client = await this.#connected();
        try {
          return await client.callTool(name, args, {
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: this.#spec.timeoutMs,
          });
        } catch (error) {
          if (error instanceof McpSessionExpiredError && attempt === 0) {
            await this.#drop(client);
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
        execute: async (args, _api, context) => {
          const result = await this.call(
            tool.name,
            isRecord(args) ? args : {},
            context.abortSignal,
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

  constructor(
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings = DEFAULT_MCP_TIMINGS,
  ) {
    this.#registry = registry;
    this.#transport = transport;
    this.#timings = timings;
  }

  get servers(): readonly McpServer[] {
    return [...this.#servers.values()];
  }

  /** The extensions as installed now, to pass to `configure({ extensions: { add } })`: only the names are stored. */
  get extensions(): Extension[] {
    return this.servers.map((server) => server.extension);
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
