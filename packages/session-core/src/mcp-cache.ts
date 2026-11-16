import type pg from "pg";
import { errorMessage } from "./http.js";
import { MCP_SERVERS_CHANNEL, mcpServersEqual, readMcpServers } from "./mcp-servers.js";
import type { McpServerConfig } from "./mcp-servers.js";

export interface McpCatalogCacheOptions {
  /** Poll interval; the safety net for a missed notification. */
  pollMs?: number;
  /** Wait before the LISTEN connection is re-established. */
  relistenMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export type McpCatalogListener = (servers: readonly McpServerConfig[]) => void;

/**
 * What the orchestrator reads the MCP catalog through. Like `SettingsCache`: loads at start, refreshes on a
 * notification of channel `pi_mcp_servers` (sent by the writer in the same transaction) and on a poll. A failed read
 * keeps the last good catalog and logs once; the catalog starts empty, so a database that cannot be read at start
 * means "no MCP servers" until it can. Listeners run after every load that changed something.
 */
export class McpCatalogCache {
  readonly #pool: pg.Pool;
  readonly #pollMs: number;
  readonly #relistenMs: number;
  readonly #log: NonNullable<McpCatalogCacheOptions["log"]>;
  #current: McpServerConfig[] = [];
  #listeners = new Set<McpCatalogListener>();
  #listener: pg.PoolClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();
  /** Problems already logged, so a poll does not repeat them every 30 s; cleared by a load with none. */
  readonly #reported = new Set<string>();
  #loaded = false;

  constructor(pool: pg.Pool, options: McpCatalogCacheOptions = {}) {
    this.#pool = pool;
    this.#pollMs = options.pollMs ?? 30_000;
    this.#relistenMs = options.relistenMs ?? 2_000;
    this.#log = options.log ?? (() => undefined);
  }

  /** Loads once (a failure is logged, not thrown), then listens and polls. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.refresh(), this.#pollMs);
    this.#timer.unref();
    void this.#listen();
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#releaseListener();
    return Promise.resolve();
  }

  #releaseListener(): void {
    const client = this.#listener;
    this.#listener = undefined;
    if (client === undefined) return;
    try {
      client.removeAllListeners();
      client.release(true);
    } catch {
      // Already released or destroyed: nothing left to do.
    }
  }

  /** Reads the table now. Reads are serialised, so the last one issued is the last one applied. */
  refresh(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#load());
    return this.#queue;
  }

  /** True once the table has been read at least once. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** The last good catalog: every valid row, enabled or not. */
  get(): readonly McpServerConfig[] {
    return this.#current;
  }

  /** Called with the new catalog after every load that changed it. Returns the unsubscribe. */
  subscribe(listener: McpCatalogListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #load(): Promise<void> {
    try {
      const catalog = await readMcpServers(this.#pool);
      for (const bad of catalog.invalid) this.#report("mcp-server-invalid", bad.message);
      if (catalog.invalid.length === 0) this.#reported.clear();
      const next = catalog.servers.map((stored) => stored.server);
      const changed =
        !this.#loaded ||
        next.length !== this.#current.length ||
        next.some((server, i) => {
          const before = this.#current[i];
          return before === undefined || !mcpServersEqual(before, server);
        });
      this.#loaded = true;
      if (!changed) return;
      this.#current = next;
      this.#log("mcp-catalog-loaded", {
        servers: next.map((s) => `${s.name}${s.enabled ? "" : " (disabled)"}`),
      });
      for (const listener of [...this.#listeners]) {
        try {
          listener(next);
        } catch (error) {
          this.#report("mcp-catalog-listener-failed", errorMessage(error));
        }
      }
    } catch (error) {
      this.#report("mcp-catalog-load-failed", errorMessage(error));
    }
  }

  /** Logs a problem once per distinct message. */
  #report(event: string, message: string): void {
    const key = `${event}:${message}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#log(event, { message });
  }

  async #listen(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.#pool.connect();
        this.#listener = client;
        await new Promise<void>((resolve) => {
          client.on("notification", () => void this.refresh());
          client.on("error", () => resolve());
          client.on("end", () => resolve());
          client
            .query(`listen ${MCP_SERVERS_CHANNEL}`)
            // A change between the load and the LISTEN would otherwise wait for the poll.
            .then(() => this.refresh())
            .catch(() => resolve());
        });
        this.#releaseListener();
      } catch (error) {
        this.#log("mcp-catalog-listen-failed", { message: errorMessage(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, this.#relistenMs));
    }
  }
}
