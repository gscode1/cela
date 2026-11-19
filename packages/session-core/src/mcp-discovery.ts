import type pg from "pg";

/**
 * The latest outcome of one orchestrator's discovery of one MCP server's tools (ADR 0044). `checkedAt` is the database
 * clock at the write, an ISO string. Disabled and unreported servers have no outcome: ingest derives those states.
 */
export type McpDiscoveryOutcome =
  | { state: "ready"; tools: number; toolNames: string[]; checkedAt: string }
  | { state: "failed"; error: string; checkedAt: string };

/** What an orchestrator reports; the database adds `checkedAt`. */
export type McpDiscoveryReport =
  { state: "ready"; tools: number; toolNames: string[] } | { state: "failed"; error: string };

/** What the API shows of a server: the outcome of the shard it is taken from, or why there is none. */
export interface McpDiscoveryView {
  state: "ready" | "failed" | "disabled" | "unknown";
  tools: number;
  toolNames?: string[];
  error?: string;
  checkedAt: string | null;
  /** The shard the outcome is from; absent while `unknown` or `disabled`. */
  shard?: number;
}

export type McpReachability = "ok" | "failing" | "unknown";

/** A server of a large catalog can list hundreds of tools: the row keeps the first of them, the count stays exact. */
export const MAX_DISCOVERY_TOOL_NAMES = 200;
const MAX_TOOL_NAME_LENGTH = 100;

/** Writes the outcome into this shard's own row; `checkedAt` is set by the database clock like `updatedAt`. */
export async function recordMcpDiscovery(
  pool: pg.Pool,
  shard: number,
  server: string,
  outcome: McpDiscoveryReport,
): Promise<void> {
  const body =
    outcome.state === "ready"
      ? {
          ...outcome,
          toolNames: outcome.toolNames
            .slice(0, MAX_DISCOVERY_TOOL_NAMES)
            .map((name) => name.slice(0, MAX_TOOL_NAME_LENGTH)),
        }
      : outcome;
  await pool.query(
    `update inbox.shard_status set mcp_discovery = jsonb_set(mcp_discovery, array[$2::text],
    $3::jsonb || jsonb_build_object('checkedAt', to_char(clock_timestamp() at time zone 'utc',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true), updated_at = clock_timestamp() where shard = $1`,
    [shard, server, JSON.stringify(body)],
  );
}

/** The server left the catalog or was replaced: its old outcome says nothing about the new one. */
export async function clearMcpDiscovery(
  pool: pg.Pool,
  shard: number,
  server: string,
): Promise<void> {
  await pool.query(
    `update inbox.shard_status set mcp_discovery = mcp_discovery - $2::text, updated_at = clock_timestamp()
    where shard = $1`,
    [shard, server],
  );
}

/** Every shard's outcomes by server name; shards that have not published have no entry. */
export async function readMcpDiscovery(
  pool: pg.Pool,
): Promise<Map<string, Map<number, McpDiscoveryOutcome>>> {
  const { rows } = await pool.query<{
    shard: number;
    mcpDiscovery: Record<string, McpDiscoveryOutcome> | null;
  }>(`select shard, mcp_discovery as "mcpDiscovery" from inbox.shard_status order by shard`);
  const byServer = new Map<string, Map<number, McpDiscoveryOutcome>>();
  for (const row of rows) {
    for (const [server, outcome] of Object.entries(row.mcpDiscovery ?? {})) {
      const shards = byServer.get(server) ?? new Map<number, McpDiscoveryOutcome>();
      shards.set(row.shard, outcome);
      byServer.set(server, shards);
    }
  }
  return byServer;
}

/**
 * One view for a server that several shards may report on. A failure on any shard wins (the lowest such shard, with
 * its error): one shard that cannot reach the server is what an admin has to act on. Otherwise the lowest shard's
 * `ready`. No report at all is `unknown`, and a disabled server is `disabled` whatever an orchestrator last said.
 */
export function discoveryView(
  enabled: boolean,
  shards: ReadonlyMap<number, McpDiscoveryOutcome> | undefined,
): { reachability: McpReachability; discovery: McpDiscoveryView } {
  if (!enabled) {
    return { reachability: "unknown", discovery: { state: "disabled", tools: 0, checkedAt: null } };
  }
  const ordered = [...(shards ?? [])].sort(([a], [b]) => a - b);
  const failed = ordered.find(([, outcome]) => outcome.state === "failed");
  const chosen = failed ?? ordered[0];
  if (chosen === undefined) {
    return { reachability: "unknown", discovery: { state: "unknown", tools: 0, checkedAt: null } };
  }
  const [shard, outcome] = chosen;
  if (outcome.state === "failed") {
    return {
      reachability: "failing",
      discovery: {
        state: "failed",
        tools: 0,
        error: outcome.error,
        checkedAt: outcome.checkedAt,
        shard,
      },
    };
  }
  return {
    reachability: "ok",
    discovery: {
      state: "ready",
      tools: outcome.tools,
      toolNames: outcome.toolNames,
      checkedAt: outcome.checkedAt,
      shard,
    },
  };
}
