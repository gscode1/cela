/**
 * Notes for a save, from "Impact of a save" in docs/admin-ui-plan.md. "Applies to new sessions only" is said once per
 * page by the screens; here are only the notes that belong to one field, shown when that field changed.
 */

const TURN_BUDGET =
  "Applies to sessions using the global budget from their next message; sessions already over it stop.";

const TOKEN_BUDGET =
  "Applies to sessions using the global budget from their next message; sessions already over it stop. One run can go past it.";

const PROFILE_TOKEN_BUDGET = "Checked before each message, so one run can go past it.";

const REPO_ALLOWLIST =
  "Applies to new repo sessions at once. A running session of a removed repository loses access when its GitHub token next renews, within an hour.";

export function settingsImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  if (changed.includes("tokenBudget")) notes.push(TOKEN_BUDGET);
  if (changed.includes("repoAllowlist")) notes.push(REPO_ALLOWLIST);
  return notes;
}

export function profileImpact(changed: readonly string[]): string[] {
  const notes: string[] = [];
  if (changed.includes("repoSkills") || changed.includes("repoContext"))
    notes.push(
      "Repository instructions and skills come from the session's checkout and can refresh during the session.",
    );
  if (changed.includes("turnBudget")) notes.push(TURN_BUDGET);
  if (changed.includes("tokenBudget")) notes.push(PROFILE_TOKEN_BUDGET);
  if (changed.includes("egressRuleSets"))
    notes.push(
      "A running session keeps the rule sets of the version it started with; edits to the rules inside a set reach every session that uses it.",
    );
  return notes;
}
