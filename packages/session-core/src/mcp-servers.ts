import type pg from "pg";
import {
  AdminBlockedError,
  blockedMessage,
  lockCatalog,
  profilesReferring,
  recordDeletion,
  refuseDeletedName,
} from "./deletion.js";
import { checkRevision } from "./revision.js";
import { sourceFromColumn, sourcesEqual, validateSource } from "./source.js";
import type { CatalogSource } from "./source.js";

/** Notification channel a writer signals on, in the same transaction as the write. */
export const MCP_SERVERS_CHANNEL = "pi_mcp_servers";

/**
 * One MCP server of the catalog (docs/decisions/0009-mcp-catalog-in-postgres.md). This is also the wire shape of the
 * admin API, so a GET can be edited and PUT back.
 */
export interface McpServerConfig {
  /** Names the extension `mcp-<name>` and the tools `mcp__<name>__<tool>`. Immutable. */
  name: string;
  /** https only, no credentials: the gateway is the only way out of the cluster. */
  url: string;
  transport: "streamable-http";
  /** A disabled server stays in the table, and its tools settle `tool_unavailable`. */
  enabled: boolean;
  /** The operator's declaration that the server is stateless and does not change anything (one client serves every conversation). */
  readOnly: boolean;
  /** One `callTool`, including the connect it may need. */
  timeoutMs: number;
  /** What the model gets of one result at most; the output is cut to it (the middle of long text is dropped). */
  maxOutputBytes: number;
  /** A reference to the OneCLI secret or grant for the server, never the secret itself. Unused until #42. */
  onecliSecret: string | null;
}

export interface StoredMcpServer {
  server: McpServerConfig;
  /** Counts the writes, enable and disable included; the next write's `expectedRevision`. */
  revision: number;
  /** Reserved for a catalog repository sync; not part of `server`, so no orchestrator reacts to it. */
  source: CatalogSource | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface McpServerHistoryEntry {
  id: string;
  changedAt: Date;
  changedBy: string;
  name: string;
  action: "create" | "update" | "delete";
  old: McpServerConfig | null;
  new: McpServerConfig | null;
}

export const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const MCP_TRANSPORT = "streamable-http";
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
export const MIN_MCP_TIMEOUT_MS = 1_000;
export const MAX_MCP_TIMEOUT_MS = 300_000;
/** The default is also the ceiling: pi-mcp's `limitMcpContent` already cuts text at 20 KB, so a row can only tighten. */
export const MAX_MCP_OUTPUT_BYTES = 24 * 1024;
export const MIN_MCP_OUTPUT_BYTES = 1024;
const MAX_URL = 2048;
const MAX_SECRET_REF = 200;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const KEYS = [
  "url",
  "transport",
  "enabled",
  "readOnly",
  "timeoutMs",
  "maxOutputBytes",
  "onecliSecret",
] as const;

/** The value of a server the input does not say anything about. `url` and `readOnly` have none: they are required. */
const DEFAULTS = {
  transport: MCP_TRANSPORT,
  enabled: true,
  timeoutMs: DEFAULT_MCP_TIMEOUT_MS,
  maxOutputBytes: MAX_MCP_OUTPUT_BYTES,
  onecliSecret: null,
} as const;

/** Whether `name` can be a server name; the message for a 400 otherwise. */
export function mcpServerNameError(name: unknown): string | undefined {
  if (typeof name !== "string" || !MCP_SERVER_NAME.test(name)) {
    return `server name must match ${MCP_SERVER_NAME.source}`;
  }
  // `/admin/mcp-servers/history` is the history route.
  return name === "history" ? 'server name "history" is reserved' : undefined;
}

/**
 * The one validator: admin writes (`current` is the stored row for a partial update, undefined for a create) and
 * stored rows read back both pass through it, so a row that is written is a row that can be read. Returns the
 * normalised server or the message for a 400. `name` comes from the path (or the row), never from the body, except that
 * a body may repeat it.
 */
export function validateMcpServer(
  name: string,
  input: unknown,
  current?: McpServerConfig,
): McpServerConfig | string {
  const nameError = mcpServerNameError(name);
  if (nameError !== undefined) return nameError;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "server must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key === "name") {
      if (body.name !== name) return "name is immutable and must match the path";
      continue;
    }
    if (!(KEYS as readonly string[]).includes(key)) return `unknown field "${key.slice(0, 50)}"`;
  }
  const pick = (key: (typeof KEYS)[number]): unknown => {
    if (key in body) return body[key];
    if (current !== undefined) return current[key];
    return (DEFAULTS as Record<string, unknown>)[key];
  };

  const urlText = pick("url");
  if (typeof urlText !== "string") return "url is required";
  if (urlText.length > MAX_URL) return `url must have at most ${String(MAX_URL)} characters`;
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return "url must be a valid URL";
  }
  if (url.protocol !== "https:") return "url must be https";
  // The stored text is the normalised one (spaces become %20 and so on), so that is the length the table allows.
  if (url.toString().length > MAX_URL) {
    return `url must have at most ${String(MAX_URL)} characters once normalised`;
  }
  if (url.username !== "" || url.password !== "") return "url must not carry credentials";
  if (pick("transport") !== MCP_TRANSPORT) return `transport must be "${MCP_TRANSPORT}"`;
  const enabled = pick("enabled");
  if (typeof enabled !== "boolean") return "enabled must be a boolean";
  const readOnly = pick("readOnly");
  if (typeof readOnly !== "boolean") {
    return "readOnly is required: declare whether the server is stateless and read-only (true or false)";
  }
  const timeoutMs = pick("timeoutMs");
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_MCP_TIMEOUT_MS ||
    timeoutMs > MAX_MCP_TIMEOUT_MS
  ) {
    return `timeoutMs must be an integer from ${String(MIN_MCP_TIMEOUT_MS)} to ${String(MAX_MCP_TIMEOUT_MS)}`;
  }
  const maxOutputBytes = pick("maxOutputBytes");
  if (
    typeof maxOutputBytes !== "number" ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < MIN_MCP_OUTPUT_BYTES ||
    maxOutputBytes > MAX_MCP_OUTPUT_BYTES
  ) {
    return `maxOutputBytes must be an integer from ${String(MIN_MCP_OUTPUT_BYTES)} to ${String(MAX_MCP_OUTPUT_BYTES)}`;
  }
  const secret = pick("onecliSecret");
  if (
    secret !== null &&
    (typeof secret !== "string" || secret.length > MAX_SECRET_REF || !SECRET_REF.test(secret))
  ) {
    return `onecliSecret must be null or a reference of at most ${String(MAX_SECRET_REF)} characters (letters, digits and ._:/-)`;
  }
  return {
    name,
    url: url.toString(),
    transport: MCP_TRANSPORT,
    enabled,
    readOnly,
    timeoutMs,
    maxOutputBytes,
    onecliSecret: secret,
  };
}

/** The fields the orchestrator acts on: a server that differs in none of them needs no new client. */
export function mcpServersEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface McpRow {
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  read_only: boolean;
  timeout_ms: number;
  max_output_bytes: number;
  onecli_secret: string | null;
  revision: number;
  source: unknown;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

const COLUMNS =
  "name, url, transport, enabled, read_only, timeout_ms, max_output_bytes, onecli_secret, revision, source, created_at, created_by, updated_at, updated_by";

/** A stored row, validated like input: a bad row throws (or is reported by `readMcpServers`), never used. */
function fromRow(row: McpRow): StoredMcpServer {
  const server = validateMcpServer(row.name, {
    url: row.url,
    transport: row.transport,
    enabled: row.enabled,
    readOnly: row.read_only,
    timeoutMs: row.timeout_ms,
    maxOutputBytes: row.max_output_bytes,
    onecliSecret: row.onecli_secret,
  });
  if (typeof server === "string") {
    throw new Error(`stored MCP server ${row.name} is invalid: ${server}`);
  }
  return {
    server,
    revision: row.revision,
    source: sourceFromColumn(row.source),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

type Db = pg.Pool | pg.PoolClient;

export interface McpCatalog {
  servers: StoredMcpServer[];
  /** Rows the validator rejects (edited by hand): skipped, so one bad row never takes the others down. */
  invalid: { name: string; message: string }[];
}

/** Every row by name; invalid rows are reported, not thrown. */
export async function readMcpServers(db: Db): Promise<McpCatalog> {
  const { rows } = await db.query<McpRow>(`select ${COLUMNS} from inbox.mcp_servers order by name`);
  const catalog: McpCatalog = { servers: [], invalid: [] };
  for (const row of rows) {
    try {
      catalog.servers.push(fromRow(row));
    } catch (error) {
      catalog.invalid.push({
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return catalog;
}

async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeHistoryAndNotify(
  client: pg.PoolClient,
  by: string,
  name: string,
  action: McpServerHistoryEntry["action"],
  old: McpServerConfig | null,
  next: McpServerConfig | null,
): Promise<void> {
  await client.query(
    "insert into inbox.mcp_servers_history (changed_by, name, action, old, new) values ($1, $2, $3, $4, $5)",
    [
      by,
      name,
      action,
      old === null ? null : JSON.stringify(old),
      next === null ? null : JSON.stringify(next),
    ],
  );
  await client.query("select pg_notify($1, $2)", [MCP_SERVERS_CHANNEL, name]);
}

export interface PutResult {
  stored: StoredMcpServer;
  created: boolean;
}

/**
 * Creates or updates one server from `by` (the owner name). A create needs `url` and `readOnly`; an update lays the
 * body over the stored row (locked, so two admins cannot interleave). Row, history and notification are written in one
 * transaction; a change that alters nothing writes nothing. Resolves to the stored server or the message for a 400.
 */
export async function putMcpServer(
  pool: pg.Pool,
  name: string,
  input: unknown,
  by: string,
  expectedRevision?: number,
): Promise<PutResult | string> {
  // `source` is not part of the server: it is split off, checked on its own and stored beside the row.
  let body = input;
  let source: CatalogSource | null | undefined;
  if (typeof input === "object" && input !== null && !Array.isArray(input) && "source" in input) {
    const { source: given, ...rest } = input as Record<string, unknown>;
    body = rest;
    if (given === null) source = null;
    else {
      const checked = validateSource(given);
      if (typeof checked === "string") return checked;
      source = checked;
    }
  }
  return inTransaction(pool, async (client) => {
    await lockCatalog(client, "exclusive");
    // `for update` locks nothing while the row does not exist, so two creates of one name would both see "no row", and
    // the second would overwrite the first with create defaults. The advisory lock serialises writers per name.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`mcp:${name}`]);
    const { rows } = await client.query<McpRow>(
      `select ${COLUMNS} from inbox.mcp_servers where name = $1 for update`,
      [name],
    );
    checkRevision(`MCP server ${name}`, expectedRevision, rows[0]?.revision);
    // A deleted name is never created again: old conversations stored it and would pick up the new server.
    if (rows[0] === undefined) await refuseDeletedName(client, "mcp-server", name);
    // A stored row that no longer validates is replaced by the body alone, which must then be complete.
    let current: StoredMcpServer | undefined;
    try {
      current = rows[0] === undefined ? undefined : fromRow(rows[0]);
    } catch {
      current = undefined;
    }
    const next = validateMcpServer(name, body, current?.server);
    if (typeof next === "string") return next;
    // An omitted `source` keeps the stored one (the body lays over the row), `null` clears it.
    const nextSource = source === undefined ? (current?.source ?? null) : source;
    if (
      current !== undefined &&
      mcpServersEqual(current.server, next) &&
      sourcesEqual(current.source, nextSource)
    ) {
      return { stored: current, created: false };
    }
    const { rows: written } = await client.query<McpRow>(
      `insert into inbox.mcp_servers
         (name, url, transport, enabled, read_only, timeout_ms, max_output_bytes, onecli_secret, source, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       on conflict (name) do update set
         url = excluded.url, transport = excluded.transport, enabled = excluded.enabled,
         read_only = excluded.read_only, timeout_ms = excluded.timeout_ms,
         max_output_bytes = excluded.max_output_bytes, onecli_secret = excluded.onecli_secret,
         source = excluded.source, revision = inbox.mcp_servers.revision + 1,
         updated_at = clock_timestamp(), updated_by = excluded.updated_by
       returning ${COLUMNS}`,
      [
        name,
        next.url,
        next.transport,
        next.enabled,
        next.readOnly,
        next.timeoutMs,
        next.maxOutputBytes,
        next.onecliSecret,
        nextSource === null ? null : JSON.stringify(nextSource),
        by,
      ],
    );
    const created = rows[0] === undefined;
    await writeHistoryAndNotify(
      client,
      by,
      name,
      created ? "create" : "update",
      current?.server ?? null,
      next,
    );
    const row = written[0];
    return {
      stored:
        row === undefined
          ? fromStored(next, nextSource, (rows[0]?.revision ?? 0) + 1, by)
          : fromRow(row),
      created,
    };
  });
}

function fromStored(
  server: McpServerConfig,
  source: CatalogSource | null,
  revision: number,
  by: string,
): StoredMcpServer {
  const now = new Date();
  return { server, revision, source, createdAt: now, createdBy: by, updatedAt: now, updatedBy: by };
}

/**
 * Removes the row (a real delete: the history keeps what it was, ADR 0027). Refused while a profile's current version
 * names the server; sessions do not block it, their calls settle `tool_unavailable`. The name is never used again, so
 * no old conversation picks up another server under it. False if there was none; throws `AdminConflictError` when
 * `expectedRevision` is not the stored one, `AdminBlockedError` when a profile names it.
 */
export async function deleteMcpServer(
  pool: pg.Pool,
  name: string,
  by: string,
  expectedRevision: number,
): Promise<boolean> {
  if (mcpServerNameError(name) !== undefined) return false;
  return inTransaction(pool, async (client) => {
    await lockCatalog(client, "exclusive");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`mcp:${name}`]);
    const { rows: found } = await client.query<McpRow>(
      `select ${COLUMNS} from inbox.mcp_servers where name = $1 for update`,
      [name],
    );
    if (found[0] === undefined) return false;
    checkRevision(`MCP server ${name}`, expectedRevision, found[0].revision);
    const profiles = await profilesReferring(client, "mcp-server", name);
    if (profiles.length > 0) {
      throw new AdminBlockedError(blockedMessage("mcp-server", name, { profiles }), { profiles });
    }
    await recordDeletion(client, "mcp-server", name, by, null);
    const { rows } = await client.query<McpRow>(
      `delete from inbox.mcp_servers where name = $1 returning ${COLUMNS}`,
      [name],
    );
    const row = rows[0];
    if (row === undefined) return false;
    let old: McpServerConfig | null = null;
    try {
      old = fromRow(row).server;
    } catch {
      // A row edited by hand into something invalid is still deleted; the history just has no typed old value.
    }
    await writeHistoryAndNotify(client, by, name, "delete", old, null);
    return true;
  });
}

/** Newest first. */
export async function listMcpServerHistory(
  pool: pg.Pool,
  limit: number,
  name?: string,
): Promise<McpServerHistoryEntry[]> {
  const { rows } = await pool.query<{
    id: string;
    changed_at: Date;
    changed_by: string;
    name: string;
    action: McpServerHistoryEntry["action"];
    old: McpServerConfig | null;
    new: McpServerConfig | null;
  }>(
    `select id, changed_at, changed_by, name, action, old, new from inbox.mcp_servers_history
     where ($2::text is null or name = $2) order by id desc limit $1`,
    [limit, name ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    name: row.name,
    action: row.action,
    old: row.old,
    new: row.new,
  }));
}
