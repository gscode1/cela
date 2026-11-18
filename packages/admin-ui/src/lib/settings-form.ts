import { PROFILE_NAME } from "@/lib/profile-form";
import { exceedsReasoning } from "@/lib/admission";
import type { ReasoningLevel, SettingsValues } from "@/lib/api/settings";

const MAX_ALLOWLIST = 100;
const MAX_ENTRY = 200;
const MAX_TURN_BUDGET = 1_000_000;
const MAX_TOKEN_BUDGET = 1_000_000_000_000;
const MAX_REPO_ALLOWLIST = 200;

/** What the editor holds while an operator types: the list and the number are text until they are checked. */
export interface SettingsForm {
  defaultModel: string;
  allowlist: string[];
  /** Empty for "not set", which is sent as `null`. */
  reasoning: ReasoningLevel | "";
  maxReasoning: ReasoningLevel | "";
  defaultProfile: string;
  turnBudgetText: string;
  /** Empty for "no limit", which is sent as `null`. */
  tokenBudgetText: string;
  /** One allowlist entry per line. */
  repoAllowlistText: string;
}

export function formFromValues(values: SettingsValues): SettingsForm {
  return {
    defaultModel: values.defaultModel,
    allowlist: values.allowlist,
    reasoning: values.reasoning ?? "",
    maxReasoning: values.maxReasoning ?? "",
    defaultProfile: values.defaultProfile,
    turnBudgetText: String(values.turnBudget),
    tokenBudgetText: values.tokenBudget === null ? "" : String(values.tokenBudget),
    repoAllowlistText: values.repoAllowlist.join("\n"),
  };
}

/** The allowlist has the default model first, as the API stores it. Clearing reasoning gives `null`: omitted means "keep". */
export function valuesFromForm(form: SettingsForm): SettingsValues {
  const defaultModel = form.defaultModel.trim();
  return {
    defaultModel,
    allowlist: [...new Set([defaultModel, ...form.allowlist])].filter((entry) => entry !== ""),
    reasoning: form.reasoning === "" ? null : form.reasoning,
    maxReasoning: form.maxReasoning === "" ? null : form.maxReasoning,
    defaultProfile: form.defaultProfile,
    turnBudget: Number(form.turnBudgetText.trim() === "" ? Number.NaN : form.turnBudgetText),
    tokenBudget: form.tokenBudgetText.trim() === "" ? null : Number(form.tokenBudgetText.trim()),
    // Lowercased and deduplicated as the API stores it, so retyping an entry in another case is not a change.
    repoAllowlist: [
      ...new Set(
        form.repoAllowlistText
          .split("\n")
          .map((line) => line.trim().toLowerCase())
          .filter((line) => line !== ""),
      ),
    ],
  };
}

/** The order of the allowlists carries no meaning, so a reordering is not a change. */
export function sameSettings(a: SettingsValues, b: SettingsValues): boolean {
  const norm = (values: SettingsValues): string =>
    JSON.stringify({
      ...values,
      allowlist: [...values.allowlist].sort(),
      repoAllowlist: [...values.repoAllowlist].sort(),
    });
  return norm(a) === norm(b);
}

function isModelKey(entry: string): boolean {
  const slash = entry.indexOf("/");
  return slash > 0 && slash < entry.length - 1 && !/\s/.test(entry) && entry.length <= MAX_ENTRY;
}

// The rules of `repoError` and `repoPatternError` (packages/session-core/src/repo.ts).
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function isRepo(repo: string): boolean {
  const [owner = "", name = ""] = repo.split("/");
  return (
    repo.length <= 140 &&
    REPO.test(repo) &&
    owner.length <= 39 &&
    !owner.startsWith("-") &&
    !owner.endsWith("-") &&
    !repo.includes("..") &&
    name !== "." &&
    !name.startsWith("-") &&
    name.length <= 100 &&
    !name.toLowerCase().endsWith(".git")
  );
}

/** `*`, `owner/*` or `owner/name`. */
export function isRepoPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  return isRepo(pattern.endsWith("/*") ? `${pattern.slice(0, -2)}/x` : pattern);
}

/** The messages `validateSettings` (packages/session-core/src/settings.ts) would answer with `400`. */
export function settingsProblems(values: SettingsValues): string[] {
  const problems: string[] = [];
  for (const entry of [values.defaultModel, ...values.allowlist])
    if (!isModelKey(entry)) problems.push(`model "${entry.slice(0, 80)}" is not provider/model`);
  if (new Set([values.defaultModel, ...values.allowlist]).size > MAX_ALLOWLIST)
    problems.push(
      `allowlist (with the default model) must have at most ${String(MAX_ALLOWLIST)} distinct provider/model entries`,
    );
  if (
    values.reasoning !== null &&
    values.maxReasoning !== null &&
    exceedsReasoning(values.reasoning, values.maxReasoning)
  )
    problems.push(`reasoning ${values.reasoning} is above maxReasoning ${values.maxReasoning}`);
  if (!PROFILE_NAME.test(values.defaultProfile)) problems.push("choose a default profile");
  if (
    !Number.isInteger(values.turnBudget) ||
    values.turnBudget < 1 ||
    values.turnBudget > MAX_TURN_BUDGET
  )
    problems.push(`turnBudget must be an integer from 1 to ${String(MAX_TURN_BUDGET)}`);
  if (
    values.tokenBudget !== null &&
    (!Number.isInteger(values.tokenBudget) ||
      values.tokenBudget < 1 ||
      values.tokenBudget > MAX_TOKEN_BUDGET)
  )
    problems.push(`tokenBudget must be null or an integer from 1 to ${String(MAX_TOKEN_BUDGET)}`);
  for (const entry of values.repoAllowlist)
    if (!isRepoPattern(entry))
      problems.push(`repo allowlist entry "${entry.slice(0, 80)}" is not *, owner/* or owner/name`);
  if (values.repoAllowlist.length > MAX_REPO_ALLOWLIST)
    problems.push(`repoAllowlist must have at most ${String(MAX_REPO_ALLOWLIST)} distinct entries`);
  return problems;
}
