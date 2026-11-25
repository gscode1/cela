import { mcpServerName, registerGet, registerList, type AdminContext } from "./context.js";

/** The MCP catalog (`/admin/mcp-servers`): reads now; put and delete come with the writes and dangerous tiers (ADR 0070). */
export function registerMcpServerTools(ctx: AdminContext): void {
  registerList(
    ctx,
    "mcp_servers",
    "mcp-servers",
    "List the MCP catalog servers: url, enabled, readOnly, reachability and discovery status.",
  );
  registerGet(
    ctx,
    "mcp_server",
    "mcp-servers",
    mcpServerName,
    "Get one MCP catalog server: url, enabled, readOnly, timeouts, reachability and discovery status.",
  );
}
