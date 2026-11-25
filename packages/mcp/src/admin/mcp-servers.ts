import { z } from "zod";
import {
  destructiveAnnotations,
  MAX_REVISION,
  mcpServerName,
  registerGet,
  registerList,
  untrusted,
  writeAnnotations,
  type AdminContext,
} from "./context.js";

/**
 * The body fields of a PUT, as in session-core's `McpServerConfig` without `name` (the path) and `transport` (one value,
 * the default). The limits are the validator's (`validateMcpServer`); a test keeps the keys equal.
 */
export const MCP_SERVER_SHAPE = {
  url: z.string().max(2048).describe("https URL of the server, without credentials."),
  readOnly: z
    .boolean()
    .describe(
      "Your declaration that the server is stateless and changes nothing: one client serves every session.",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe(
      "A disabled server stays in the catalog and its tools settle tool_unavailable. Default true.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .describe("One tool call, connect included, in ms (1000 to 300000). Default 60000."),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(24576)
    .optional()
    .describe(
      "Most bytes of one result the model gets (1024 to 24576; it can only tighten). Default 24576.",
    ),
  onecliSecret: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
    .nullable()
    .optional()
    .describe(
      "The NAME of a OneCLI secret the operator created (see onecliSecrets.names of admin_list_mcp_servers), never a secret value. null: no credential. Omitted: unchanged on update, null on create.",
    ),
};

/** The MCP catalog (`/admin/mcp-servers`): reads now; put with the writes tier, delete with the dangerous one (ADR 0070). */
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
  if (!ctx.tiers.writes) return;
  ctx.server.registerTool(
    "admin_put_mcp_server",
    {
      description: `Create or update an MCP catalog server. expectedRevision 0 creates (409 if it exists or the name was deleted; url and readOnly are required); otherwise pass the current revision from admin_get_mcp_server, and on 409 reload and retry. An update lays the fields over the stored row, so omitted ones keep their value. onecliSecret is a secret name, never a value. ${untrusted}`,
      inputSchema: z.object({
        name: mcpServerName,
        expectedRevision: z
          .number()
          .int()
          .min(0)
          .max(MAX_REVISION)
          .describe("The server's current revision; 0 to create."),
        ...MCP_SERVER_SHAPE,
      }),
      annotations: writeAnnotations,
    },
    async ({ name, ...body }, extra) =>
      ctx.call("PUT", `/admin/mcp-servers/${encodeURIComponent(name)}`, extra.mcpReq.signal, body),
  );
  if (!ctx.tiers.dangerous) return;
  ctx.server.registerTool(
    "admin_delete_mcp_server",
    {
      description: `Delete an MCP catalog server at its current revision. Removes the row for real (to keep it, put enabled false); 409 while a profile's current version names it (details.blockedBy.profiles lists them), and the name cannot be created again. ${untrusted}`,
      inputSchema: z.object({
        name: mcpServerName,
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .max(MAX_REVISION)
          .describe("The server's current revision."),
      }),
      annotations: destructiveAnnotations,
    },
    async (args, extra) =>
      ctx.call(
        "DELETE",
        `/admin/mcp-servers/${encodeURIComponent(args.name)}?expectedRevision=${String(args.expectedRevision)}`,
        extra.mcpReq.signal,
      ),
  );
}
