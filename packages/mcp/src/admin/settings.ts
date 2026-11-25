import { readAnnotations, untrusted, type AdminContext } from "./context.js";
import { z } from "zod";

/** The deployment settings (`/admin/settings`): the read now; the put comes with the dangerous tier (ADR 0070). */
export function registerSettingsTools(ctx: AdminContext): void {
  ctx.server.registerTool(
    "admin_get_settings",
    {
      description: `Get the deployment settings: default model and profile, model and repo allowlists, reasoning cap, turn and token budgets. ${untrusted}`,
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async (_args, extra) => ctx.call("GET", "/admin/settings", extra.mcpReq.signal),
  );
}
