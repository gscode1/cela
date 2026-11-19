import { adminJson } from "@/lib/api/raw";
import { fieldLabel } from "@/lib/field-labels";

export interface CatalogSource {
  repository: string;
  commit: string;
}

/**
 * What the orchestrator last found when it listed the server's tools through the gateway (ADR 0044). `unknown`: no
 * orchestrator has reported since it started; `disabled`: the server is not discovered at all.
 */
export interface McpDiscovery {
  state: "ready" | "failed" | "disabled" | "unknown";
  tools: number;
  toolNames?: string[];
  /** Sanitized and at most about 300 characters. */
  error?: string;
  checkedAt: string | null;
  /** The shard whose report this is. */
  shard?: number;
}

/** One MCP server as `GET /admin/mcp-servers` returns it, and as a `PUT` body may carry its fields. */
export interface McpServer {
  name: string;
  url: string;
  transport: "streamable-http";
  enabled: boolean;
  readOnly: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  onecliSecret: string | null;
  revision: number;
  source: CatalogSource | null;
  reachability: "ok" | "failing" | "unknown";
  /** Absent from an ingest older than ADR 0044: the same as unknown. */
  discovery?: McpDiscovery;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * The names of the OneCLI secrets a server could name, as the orchestrator last listed them (up to about 30 s old).
 * `source: "none"` while unknown (no OneCLI admin key, or not published yet): an empty list then says nothing.
 */
export interface OnecliSecretNames {
  names: string[];
  source: "orchestrator" | "none";
}

export interface McpCatalog {
  servers: McpServer[];
  invalid: { name: string; message: string }[];
  /** Absent from an ingest that does not publish it: the same as unknown. */
  onecliSecrets?: OnecliSecretNames;
}

/** The known secret names, or undefined while the list is unknown. */
export function knownSecretNames(catalog: McpCatalog | undefined): string[] | undefined {
  const secrets = catalog?.onecliSecrets;
  return secrets?.source === "orchestrator" ? secrets.names : undefined;
}

export type McpFields = Pick<
  McpServer,
  "url" | "enabled" | "readOnly" | "timeoutMs" | "maxOutputBytes" | "onecliSecret"
>;

export interface McpHistoryEntry {
  id: string;
  changedAt: string;
  changedBy: string;
  name: string;
  action: "create" | "update" | "delete";
  old: McpFields | null;
  new: McpFields | null;
}

/** The limits of the validator (packages/session-core/src/mcp-servers.ts); the API stays the authority. */
export const MCP_LIMITS = {
  timeoutMs: { min: 1_000, max: 300_000, default: 60_000 },
  maxOutputBytes: { min: 1_024, max: 24_576, default: 24_576 },
} as const;

export const MCP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const MAX_SECRET_REF = 200;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Client-side hint for a typed OneCLI secret name (empty means none); mirrors the validator, the API decides. */
export function secretRefProblem(text: string): string | undefined {
  const name = text.trim();
  if (name === "") return undefined;
  if (name.length > MAX_SECRET_REF || !SECRET_REF.test(name))
    return `the OneCLI secret name has at most ${String(MAX_SECRET_REF)} letters, digits and ._:/- and starts with a letter or digit`;
  return undefined;
}

export function listMcpServers(token: string, signal?: AbortSignal): Promise<McpCatalog> {
  return adminJson<McpCatalog>(token, "/admin/mcp-servers", signal ? { signal } : {});
}

export async function mcpHistory(token: string, signal?: AbortSignal): Promise<McpHistoryEntry[]> {
  const body = await adminJson<{ history: McpHistoryEntry[] }>(
    token,
    "/admin/mcp-servers/history?limit=20",
    signal ? { signal } : {},
  );
  return body.history;
}

/** A create (no `expectedRevision`: the API refuses one for a server that does not exist) or an update. */
export function putMcpServer(
  token: string,
  name: string,
  fields: Partial<McpFields>,
  expectedRevision: number | undefined,
): Promise<McpServer> {
  return adminJson<McpServer>(token, `/admin/mcp-servers/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: expectedRevision === undefined ? fields : { ...fields, expectedRevision },
  });
}

export function deleteMcpServer(
  token: string,
  name: string,
  expectedRevision: number,
): Promise<{ name: string; deleted: true }> {
  return adminJson(
    token,
    `/admin/mcp-servers/${encodeURIComponent(name)}?expectedRevision=${String(expectedRevision)}`,
    { method: "DELETE" },
  );
}

/** Client-side hint for the URL field; the API decides (https, no credentials, at most 2048 characters). */
export function urlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "enter a full URL such as https://mcp.example.com/mcp";
  }
  if (url.protocol !== "https:") return "the URL must be https";
  if (url.username !== "" || url.password !== "") return "the URL must not carry credentials";
  return undefined;
}

export interface ScaledRange {
  /** Name shown in the message, such as "Timeout". */
  label: string;
  /** What the operator types: seconds or KB. */
  unit: string;
  /** Stored units per typed unit: 1000 ms per second, 1024 bytes per KB. */
  scale: number;
  min: number;
  max: number;
}

export const TIMEOUT_FIELD: ScaledRange = {
  label: "Timeout",
  unit: "seconds",
  scale: 1000,
  min: MCP_LIMITS.timeoutMs.min,
  max: MCP_LIMITS.timeoutMs.max,
};
export const OUTPUT_FIELD: ScaledRange = {
  label: "Max output",
  unit: "KB",
  scale: 1024,
  min: MCP_LIMITS.maxOutputBytes.min,
  max: MCP_LIMITS.maxOutputBytes.max,
};

/** What the operator types for a stored value: `60000` ms is `60`, `1500` ms is `1.5`. */
export const toTyped = (stored: number, scale: number): string => String(stored / scale);

/** The stored value (ms or bytes) for typed text, or `undefined` when it is not a plain positive number. */
export function fromTyped(text: string, scale: number): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return undefined;
  return Math.round(Number(text) * scale);
}

/** The first problem with a typed value, or `undefined`; mirrors the validator's ranges. */
export function scaledProblem(field: ScaledRange, text: string): string | undefined {
  const stored = fromTyped(text, field.scale);
  const range = `from ${String(field.min / field.scale)} to ${String(field.max / field.scale)} ${field.unit}`;
  if (stored === undefined) return `${field.label} must be a number ${range}`;
  if (stored < field.min || stored > field.max) return `${field.label} must be ${range}`;
  return undefined;
}

/** The host of a URL for a table cell; the whole text when it is not a URL. */
export function hostOf(text: string): string {
  try {
    return new URL(text).host;
  } catch {
    return text;
  }
}

/** "90 s", "1.5 s". */
export const secondsText = (ms: number): string => `${String(ms / 1000)} s`;
/** "48 KB". */
export const kbText = (bytes: number): string => `${String(bytes / 1024)} KB`;

/** Settings that differ from the defaults: the only ones a table row mentions. */
export function nonDefaultLimits(server: Pick<McpServer, "timeoutMs" | "maxOutputBytes">): {
  label: string;
  value: string;
}[] {
  const out: { label: string; value: string }[] = [];
  if (server.timeoutMs !== MCP_LIMITS.timeoutMs.default)
    out.push({ label: fieldLabel("timeoutMs"), value: secondsText(server.timeoutMs) });
  if (server.maxOutputBytes !== MCP_LIMITS.maxOutputBytes.default)
    out.push({ label: fieldLabel("maxOutputBytes"), value: kbText(server.maxOutputBytes) });
  return out;
}
