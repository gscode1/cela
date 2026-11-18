/**
 * Notes for a save, from "Impact of a save" in docs/admin-ui-plan.md. "Applies to new sessions only" is said once per
 * page by the screens; here are only the notes that belong to one field, shown when that field changed.
 */

const TURN_BUDGET =
  "Applies to sessions using the global budget from their next message; sessions already over it stop.";

const TOKEN_BUDGET =
  "Applies to every session from its next message; sessions already over it stop. One run can go past it.";

export function settingsImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  if (changed.includes("tokenBudget")) notes.push(TOKEN_BUDGET);
  return notes;
}

export function profileImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.includes("repoSkills") || changed.includes("repoContext"))
    notes.push(
      "Repository instructions and skills come from the session's checkout and can refresh during the session.",
    );
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  return notes;
}
