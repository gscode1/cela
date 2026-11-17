import { adminJson } from "@/lib/api/raw";

export interface CatalogSource {
  repository: string;
  commit: string;
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
  reachability: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface McpCatalog {
  servers: McpServer[];
  invalid: { name: string; message: string }[];
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

/** What the form may be saved with, or the first problem; mirrors the validator's ranges. */
export function numberProblem(
  label: string,
  text: string,
  range: { min: number; max: number },
): string | undefined {
  if (!/^\d+$/.test(text.trim())) return `${label} must be a whole number`;
  const value = Number(text);
  if (value < range.min || value > range.max)
    return `${label} must be from ${String(range.min)} to ${String(range.max)}`;
  return undefined;
}
