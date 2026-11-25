import { z } from "zod";
import {
  readAnnotations,
  untrusted,
  writeAnnotations,
  type AdminContext,
  type Result,
} from "./context.js";

/** Deployment-wide reads and probes (catalog, status, history, session list, network probe; ADR 0070). */

const CATALOG_PARTS = [
  ["models", "/admin/models"],
  ["tools", "/admin/tools"],
  ["networkModes", "/admin/network-modes"],
  ["sandboxFlavours", "/admin/sandbox-flavours"],
  ["sandboxSizes", "/admin/sandbox-sizes"],
  ["sandboxRuntimes", "/admin/sandbox-runtimes"],
] as const;

// Egress rule ids and set names are free text to the history filter; bound them like the catalog names.
const HISTORY_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HISTORY_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const historyInput = z.object({
  kind: z.enum(["settings", "mcp_servers", "egress"]).describe("Which history table."),
  limit: z.number().int().min(1).max(500).optional().describe("Newest entries, default 50."),
  name: z
    .string()
    .regex(HISTORY_NAME)
    .optional()
    .describe("mcp_servers only: one server's entries."),
  egressKind: z.enum(["rule-set", "rule"]).optional().describe("egress only: rule sets or rules."),
  ref: z
    .string()
    .regex(HISTORY_REF)
    .optional()
    .describe("egress only: a set's name or a rule's id."),
});

const HISTORY_PATH = {
  settings: "/admin/settings/history",
  mcp_servers: "/admin/mcp-servers/history",
  egress: "/admin/egress/history",
} as const;

// Which filters each history route accepts (besides `limit`); any other is refused rather than silently ignored.
const HISTORY_FILTERS = {
  settings: [],
  mcp_servers: ["name"],
  egress: ["egressKind", "ref"],
} as const;

const sessionsInput = z.object({
  owner: z.string().min(1).max(200).optional().describe("Only this owner's sessions (exact name)."),
  status: z
    .enum(["active", "deleting", "deleted", "failed"])
    .optional()
    .describe("Only sessions in this status. Absent: every status except deleted."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
  cursor: z.string().min(1).max(2000).optional().describe("nextCursor of the previous page."),
});

export function registerDeploymentTools(ctx: AdminContext): void {
  ctx.server.registerTool(
    "admin_get_catalog",
    {
      description: `What profiles and settings may name: models, tools, network modes, sandbox flavours, sizes and runtimes, in one answer. ${untrusted}`,
      inputSchema: z.object({
        allModels: z
          .boolean()
          .optional()
          .describe(
            "Every model of the catalog (about 240 KB) instead of the configured providers'.",
          ),
      }),
      annotations: readAnnotations,
    },
    async (args, extra) => {
      const out: Record<string, unknown> = {};
      for (const [key, path] of CATALOG_PARTS) {
        const query = key === "models" && args.allModels === true ? "?all=true" : "";
        const part = await ctx.call("GET", `${path}${query}`, extra.mcpReq.signal);
        if (part.isError === true)
          return ctx.reply(
            {
              ...part.structuredContent,
              error: `${path} failed: ${String(part.structuredContent.error)}`,
            },
            true,
          );
        out[key] = part.structuredContent;
      }
      return ctx.reply(out);
    },
  );

  ctx.server.registerTool(
    "admin_get_status",
    {
      description: `Deployment status published by the orchestrator, including the network isolation probe. ${untrusted}`,
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async (_args, extra) => ctx.call("GET", "/admin/status", extra.mcpReq.signal),
  );

  ctx.server.registerTool(
    "admin_get_history",
    {
      description: `Change history, newest first, of the settings, the MCP server catalog or the egress rules. name applies to mcp_servers; egressKind and ref to egress. ${untrusted}`,
      inputSchema: historyInput,
      annotations: readAnnotations,
    },
    async (args, extra) => {
      const allowed: readonly string[] = HISTORY_FILTERS[args.kind];
      const refused = (["name", "egressKind", "ref"] as const).filter(
        (key) => args[key] !== undefined && !allowed.includes(key),
      );
      if (refused.length > 0)
        return ctx.reply(
          { error: `${refused.join(", ")} not valid for kind ${args.kind}`, status: 0 },
          true,
        );
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.name !== undefined) query.set("name", args.name);
      if (args.egressKind !== undefined) query.set("kind", args.egressKind);
      if (args.ref !== undefined) query.set("ref", args.ref);
      const text = query.toString();
      return ctx.call(
        "GET",
        `${HISTORY_PATH[args.kind]}${text === "" ? "" : `?${text}`}`,
        extra.mcpReq.signal,
      );
    },
  );

  ctx.server.registerTool(
    "admin_list_sessions",
    {
      description: `Sessions of every owner, newest first, metadata only (no transcripts). Page with nextCursor. ${untrusted}`,
      inputSchema: sessionsInput,
      annotations: readAnnotations,
    },
    async (args, extra) => {
      const query = new URLSearchParams();
      for (const key of ["owner", "status", "limit", "cursor"] as const) {
        const value = args[key];
        if (value !== undefined) query.set(key, String(value));
      }
      const text = query.toString();
      return ctx.call(
        "GET",
        `/admin/sessions${text === "" ? "" : `?${text}`}`,
        extra.mcpReq.signal,
      );
    },
  );

  if (ctx.tiers.writes) {
    ctx.server.registerTool(
      "admin_probe_network",
      {
        description: `Ask the orchestrator to run the network isolation probe again; poll admin_get_status for the result. ${untrusted}`,
        inputSchema: z.object({}),
        annotations: { ...writeAnnotations, idempotentHint: true },
      },
      async (_args, extra): Promise<Result> =>
        ctx.call("POST", "/admin/status/probe", extra.mcpReq.signal),
    );
  }
}
