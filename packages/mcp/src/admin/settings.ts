import { z } from "zod";
import {
  destructiveAnnotations,
  MAX_REVISION,
  readAnnotations,
  untrusted,
  type AdminContext,
} from "./context.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The fields of the deployment settings, as in session-core's `Settings` (a test keeps them equal). Loose on purpose,
 * as for profiles: ingest is the validator and owns the limits (list sizes, budget ranges, the model catalog).
 */
export const SETTINGS_SHAPE = {
  defaultModel: z
    .string()
    .optional()
    .describe("provider/model for sessions that name none; added to the allowlist if missing."),
  allowlist: z
    .array(z.string())
    .optional()
    .describe("provider/model pairs a session may use (at most 100); replaces the stored list."),
  reasoning: z
    .enum(LEVELS)
    .nullable()
    .optional()
    .describe("Reasoning effort for every new session; null clears it."),
  maxReasoning: z
    .enum(LEVELS)
    .nullable()
    .optional()
    .describe("Highest reasoning effort a request may ask for; null removes the cap."),
  defaultProfile: z
    .string()
    .optional()
    .describe("Existing profile, enabled for new sessions, used when a request names none."),
  turnBudget: z
    .number()
    .int()
    .optional()
    .describe("Model turns per session, 1 to 1000000 (a profile may replace it)."),
  tokenBudget: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Tokens per session, 1 to 1000000000000; null for no limit."),
  repoAllowlist: z
    .array(z.string())
    .optional()
    .describe(
      "Repos a session may clone: *, owner/* or owner/name (at most 200); replaces the stored list. Empty refuses every repo session.",
    ),
};

/** The deployment settings (`/admin/settings`): the read, and the dangerous tier's put (ADR 0070). */
export function registerSettingsTools(ctx: AdminContext): void {
  ctx.server.registerTool(
    "admin_get_settings",
    {
      description: `Get the deployment settings: default model and profile, model and repo allowlists, reasoning cap, turn and token budgets, and the revision admin_put_settings needs. ${untrusted}`,
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async (_args, extra) => ctx.call("GET", "/admin/settings", extra.mcpReq.signal),
  );
  if (!ctx.tiers.writes || !ctx.tiers.dangerous) return;
  ctx.server.registerTool(
    "admin_put_settings",
    {
      description: `Change the deployment settings for every new session: models, repo allowlist, default profile, reasoning cap, budgets. A patch, not a replacement: omitted fields keep their value, but a list you send (allowlist, repoAllowlist) replaces the stored one entirely, so read admin_get_settings first, take its revision and send only the fields to change; do not send revision, updatedAt or updatedBy. Ingest refuses a bad value or an unknown field with 400 and a stale expectedRevision with 409 (reload and retry). ${untrusted}`,
      inputSchema: z.looseObject({
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .max(MAX_REVISION)
          .describe("The settings' current revision from admin_get_settings."),
        ...SETTINGS_SHAPE,
      }),
      annotations: destructiveAnnotations,
    },
    async (args, extra) => ctx.call("PUT", "/admin/settings", extra.mcpReq.signal, args),
  );
}
