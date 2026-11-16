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
import { errorMessage, log } from "./log.js";

/**
 * Native remote MCP tools (docs/decisions/0007-native-remote-mcp.md). The orchestrator is the MCP client: its HTTP
 * requests go through the OneCLI gateway like the model calls, and nothing runs in or reaches into the sandbox.
 */

export interface McpServerSpec {
  /** Names the extension `mcp-<name>` and the tools `mcp__<name>__<tool>`. */
  name: string;
  /** https only: the gateway is the only way out of the cluster. */
  url: string;
}

const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * `PI_MCP_SERVERS`: a JSON array of `{ name, url }`. Unset or empty means the feature is off. Anything malformed
 * throws, so a typo in the manifest fails at start and is never read as "off".
 */
export function parseMcpServers(raw: string | undefined): McpServerSpec[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PI_MCP_SERVERS must be a JSON array of {name, url}");
  }
  if (!Array.isArray(parsed)) throw new Error("PI_MCP_SERVERS must be a JSON array of {name, url}");
  const specs: McpServerSpec[] = [];
  const spaces = new Set<string>();
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("PI_MCP_SERVERS entries must be objects with name and url");
    }
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !SERVER_NAME.test(name)) {
      throw new Error(`PI_MCP_SERVERS: server name must match ${SERVER_NAME.source}`);
    }
    // Names that differ only in `-` and `_` share a tool namespace (pi-mcp mcpNamespace).
    const space = name.replaceAll("-", "_");
    if (spaces.has(space)) throw new Error(`PI_MCP_SERVERS: duplicate server name ${name}`);
    spaces.add(space);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(typeof url === "string" ? url : "");
    } catch {
      throw new Error(`PI_MCP_SERVERS: server ${name} needs a valid url`);
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error(`PI_MCP_SERVERS: server ${name} url must be https`);
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new Error(`PI_MCP_SERVERS: server ${name} url must not carry credentials`);
    }
    specs.push({ name, url: parsedUrl.toString() });
  }
  return specs;
}

export interface McpTimings {
  /** One `connect` plus `listTools` attempt. */
  discoveryTimeoutMs: number;
  /** Backoff between failed discovery attempts: starts at `retryMinMs`, doubles up to `retryMaxMs`. */
  retryMinMs: number;
  retryMaxMs: number;
  /** One `callTool`, including the connect it may need. */
  callTimeoutMs: number;
}

export const DEFAULT_MCP_TIMINGS: McpTimings = {
  discoveryTimeoutMs: 15_000,
  retryMinMs: 2_000,
  retryMaxMs: 60_000,
  callTimeoutMs: 60_000,
};

/** Largest JSON-RPC message a transport accepts. pi-mcp defaults to 16 MiB; one call would hold that in memory. */
export const MCP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** What the model is given of one result, on top of `limitMcpContent` (20 KB of text, middle cut). */
const OUTPUT_LIMITS = { maxBytes: 24 * 1024, maxLines: 2000, retain: "head" } as const;

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
  /** The extension as installed now: empty until discovery succeeded. */
  extension: Extension;
  readonly #spec: McpServerSpec;
  readonly #transport: McpTransportFactory;
  readonly #timings: McpTimings;
  readonly #registry: Registry;
  readonly #stop = new AbortController();
  #client: Promise<McpClient> | undefined;
  #ready: McpClient | undefined;
  #discovery: Promise<void> | undefined;

  constructor(
    spec: McpServerSpec,
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings,
  ) {
    this.#spec = spec;
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

  /** Stops discovery and closes the connection. */
  async close(): Promise<void> {
    this.#stop.abort();
    await this.#discovery;
    const client = await this.#client?.catch(() => undefined);
    this.#client = undefined;
    this.#ready = undefined;
    await client?.close().catch(() => undefined);
  }

  async #connect(): Promise<McpClient> {
    const client = new McpClient({
      name: "pi-durable-k8s",
      version: "0.0.0",
      requestTimeoutMs: this.#timings.callTimeoutMs,
    });
    // A dropped connection or an expired session makes the next use connect again.
    client.onClose(() => {
      if (this.#ready === client) {
        this.#ready = undefined;
        this.#client = undefined;
      }
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
    const connecting = this.#connect();
    this.#client = connecting;
    // A failed connect must not stay cached.
    connecting.catch(() => {
      if (this.#client === connecting) this.#client = undefined;
    });
    return connecting;
  }

  async #drop(client: McpClient): Promise<void> {
    if (this.#ready === client) {
      this.#ready = undefined;
      this.#client = undefined;
    }
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

  async #discover(): Promise<void> {
    let delay = this.#timings.retryMinMs;
    while (!this.#stopped()) {
      try {
        const tools = await this.#listTools();
        if (this.#stopped()) return;
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
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.#stop.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        delay = Math.min(delay * 2, this.#timings.retryMaxMs);
      }
    }
  }

  /** One `callTool`; after a session expiry it connects again and tries once more (the server refused it unrun). */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.#connected();
      try {
        return await client.callTool(name, args, {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: this.#timings.callTimeoutMs,
        });
      } catch (error) {
        if (error instanceof McpSessionExpiredError && attempt === 0) {
          await this.#drop(client);
          continue;
        }
        throw error;
      }
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
        outputLimits: OUTPUT_LIMITS,
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

/** The configured servers. Empty `specs` means the feature is off: nothing is installed. */
export class McpTools {
  readonly servers: readonly McpServer[];

  constructor(
    specs: readonly McpServerSpec[],
    registry: Registry,
    transport: McpTransportFactory,
    timings: McpTimings = DEFAULT_MCP_TIMINGS,
  ) {
    this.servers = specs.map((spec) => new McpServer(spec, registry, transport, timings));
  }

  /** The extensions as installed now, to pass to `configure({ extensions: { add } })`: only the names are stored. */
  get extensions(): Extension[] {
    return this.servers.map((server) => server.extension);
  }

  start(): void {
    for (const server of this.servers) server.start();
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.close()));
  }
}
