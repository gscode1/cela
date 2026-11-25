import { registerGet, registerList, skillName, type AdminContext } from "./context.js";

/** Skills (`/admin/skills`): reads now; publish and delete come with the writes and dangerous tiers (ADR 0070). */
export function registerSkillTools(ctx: AdminContext): void {
  registerList(ctx, "skills", "skills", "List skills with their current version and description.");
  registerGet(
    ctx,
    "skill",
    "skills",
    skillName,
    "Get a skill with every version's description and file manifest.",
  );
}
