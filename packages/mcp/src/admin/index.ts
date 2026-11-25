import type { McpServer } from "@modelcontextprotocol/server";
import type { McpConfig } from "../config.js";
import { createAdminContext } from "./context.js";
import { registerDeploymentTools } from "./deployment.js";
import { registerEgressTools } from "./egress.js";
import { registerMcpServerTools } from "./mcp-servers.js";
import { registerProfileTools } from "./profiles.js";
import { registerSettingsTools } from "./settings.js";
import { registerSkillTools } from "./skills.js";

export { PROFILE_DEFINITION_SHAPE } from "./profiles.js";

/**
 * The opt-in admin tools (ADR 0050, 0070): reads of the admin API, and writes behind PI_MCP_ADMIN_WRITES and
 * PI_MCP_ADMIN_DANGEROUS. Every call goes through `SessionApi.admin` with the admin token; every answer is scrubbed of
 * both tokens before the client sees it. One file per domain; each one checks `ctx.tiers` for its own writes.
 */
export function registerAdminTools(server: McpServer, config: McpConfig): void {
  const ctx = createAdminContext(server, config);
  if (ctx === undefined) return;
  registerProfileTools(ctx);
  registerSkillTools(ctx);
  registerMcpServerTools(ctx);
  registerEgressTools(ctx);
  registerSettingsTools(ctx);
  registerDeploymentTools(ctx);
}
