/**
 * What a save does to sessions, from "Impact of a save" in docs/admin-ui-plan.md. Only the notes for what changed are
 * shown, so the operator reads what applies.
 */

const SETTINGS_NEW_SESSIONS = [
  "defaultModel",
  "allowlist",
  "reasoning",
  "maxReasoning",
  "defaultProfile",
];

const TURN_BUDGET =
  "A turn budget change applies to sessions that inherit it (no budget of their own in their profile), from their next input. A session already over the new budget fails.";

export function settingsImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.some((field) => SETTINGS_NEW_SESSIONS.includes(field)))
    notes.push(
      "Model, allowlist, reasoning and default profile apply to new sessions. Sessions that exist keep what they were created with.",
    );
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  return notes;
}

export function profileImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.length > 0)
    notes.push(
      "A new profile version applies to new sessions only. Sessions that exist keep their snapshot.",
    );
  if (changed.includes("skills"))
    notes.push("Skill versions are immutable: a pin gives new sessions exactly that version.");
  if (changed.includes("repoSkills") || changed.includes("repoContext"))
    notes.push(
      "Repository instructions and skills come from the session's checkout and can refresh during the session.",
    );
  if (changed.includes("mcpServers"))
    notes.push(
      "MCP servers are added to new sessions; a session's snapshot decides which servers it uses.",
    );
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  return notes;
}
