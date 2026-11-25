import { z } from "zod";
import {
  destructiveAnnotations,
  MAX_REVISION,
  profileName,
  readAnnotations,
  registerList,
  untrusted,
  writeAnnotations,
  type AdminContext,
} from "./context.js";

const names = (what: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z.array(z.string()).optional().describe(what);

/**
 * The fields of a profile definition, as in session-core's `ProfileDefinition` (a test keeps them equal). Loose on
 * purpose: ingest is the validator and owns the limits, so a field added there is not refused here first.
 */
export const PROFILE_DEFINITION_SHAPE = {
  tools: names(
    "Coding tools enabled, a subset of the installed ones (read, write, edit, bash). Absent: all.",
  ),
  modelTools: names("Tools offered to the model, a subset of tools. Absent: all enabled."),
  instructions: z
    .string()
    .optional()
    .describe("Text added to the system prompt (up to 8000 characters)."),
  defaultModel: z
    .string()
    .optional()
    .describe("provider/model used when a request names none; must be on the model allowlist."),
  reasoning: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Default reasoning effort; not above the settings' maxReasoning."),
  turnBudget: z
    .number()
    .int()
    .optional()
    .describe("Model turns per session; replaces the settings budget."),
  tokenBudget: z
    .number()
    .int()
    .optional()
    .describe("Tokens per session; replaces the settings budget."),
  mcpServers: names("MCP catalog servers the session gets (admin_list_mcp_servers). Absent: none."),
  skills: z
    .array(z.looseObject({ name: z.string(), version: z.number().int() }))
    .optional()
    .describe(
      "Skills as { name, version }, pinned to an exact version (digest is filled in). Needs read.",
    ),
  repoSkills: z.boolean().optional().describe("Add skills found in the cloned repo. Needs read."),
  repoContext: z
    .boolean()
    .optional()
    .describe("Add the repo's AGENTS.md or CLAUDE.md to the instructions."),
  sandboxSize: z.string().optional().describe("Sandbox size name. Absent: the deployment default."),
  sandboxSizes: names("Sizes a caller may request besides sandboxSize."),
  egressRuleSets: names(
    "Egress rule sets that apply to these sessions, besides the ones that apply to all.",
  ),
  networkMode: z
    .enum(["proxied", "direct"])
    .optional()
    .describe(
      "proxied (default: egress proxy and rules) or direct (open internet; only where the deployment allows it).",
    ),
  sandboxFlavour: z
    .enum(["default", "browser", "desktop"])
    .optional()
    .describe(
      "Sandbox image; browser adds Chromium and desktop adds a virtual desktop with apps; both only work where the deployment enables them.",
    ),
  sandboxRuntime: z
    .string()
    .regex(/^[a-z][a-z0-9]{0,15}$/)
    .optional()
    .describe(
      "Named sandbox runtime (the deployment's sandbox.runtimes). Absent: the default runtime. Proxied network mode only.",
    ),
  contextTrim: z
    .enum(["off", "images", "full"])
    .optional()
    .describe(
      "Old tool output left out of model requests: off, images (old screenshots) or full (also large old text results). Absent: images.",
    ),
};

/** Profiles (`/admin/profiles`): reads, and the writes tier's put and delete (ADR 0050). */
export function registerProfileTools(ctx: AdminContext): void {
  registerList(
    ctx,
    "profiles",
    "profiles",
    "List profiles with the default profile; enabledForNew false means new sessions cannot choose one.",
  );
  ctx.server.registerTool(
    "admin_get_profile",
    {
      description: `Get one profile: its revision (needed by put and delete), definition and version history, newest first. A version's definition is sent only when it differs from the top-level one. ${untrusted}`,
      inputSchema: z.object({
        name: profileName,
        versions: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many of the newest versions to return; 0 for none. Absent: all."),
      }),
      annotations: readAnnotations,
    },
    async (args, extra) => {
      const result = await ctx.call(
        "GET",
        `/admin/profiles/${encodeURIComponent(args.name)}`,
        extra.mcpReq.signal,
      );
      const profile = result.structuredContent;
      const list = profile.versions;
      if (result.isError === true || !Array.isArray(list)) return result;
      // The current version's definition is the top-level one: send it once.
      const current = JSON.stringify(profile.definition);
      const versions = list
        .slice(0, args.versions)
        .map((entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "definition" in entry &&
          JSON.stringify(entry.definition) === current
            ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "definition"))
            : entry,
        );
      return ctx.reply({ ...profile, versions });
    },
  );
  if (!ctx.tiers.writes) return;
  ctx.server.registerTool(
    "admin_put_profile",
    {
      description: `Create or update a profile. expectedRevision 0 creates (409 if it exists); otherwise pass the current revision from admin_get_profile, and on 409 reload and retry. An identical definition writes no new version. Omit definition to change only enabledForNew. ${untrusted}`,
      inputSchema: z.object({
        name: profileName,
        expectedRevision: z
          .number()
          .int()
          .min(0)
          .max(MAX_REVISION)
          .describe("The profile's current revision; 0 to create."),
        definition: z
          .looseObject(PROFILE_DEFINITION_SHAPE)
          .optional()
          .describe(
            "The complete definition, not a patch: it replaces the current one, and omitted fields revert to their defaults.",
          ),
        enabledForNew: z
          .boolean()
          .optional()
          .describe("Whether new sessions may choose the profile (default true on create)."),
      }),
      annotations: writeAnnotations,
    },
    async ({ name, ...body }, extra) =>
      ctx.call("PUT", `/admin/profiles/${encodeURIComponent(name)}`, extra.mcpReq.signal, body),
  );
  ctx.server.registerTool(
    "admin_delete_profile",
    {
      description: `Delete a profile at its current revision. It must be disabled (enabledForNew false) and not the default profile; running sessions keep their snapshot, and the name cannot be created again. ${untrusted}`,
      inputSchema: z.object({
        name: profileName,
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .max(MAX_REVISION)
          .describe("The profile's current revision."),
      }),
      annotations: destructiveAnnotations,
    },
    async (args, extra) =>
      ctx.call(
        "DELETE",
        `/admin/profiles/${encodeURIComponent(args.name)}?expectedRevision=${String(args.expectedRevision)}`,
        extra.mcpReq.signal,
      ),
  );
}
