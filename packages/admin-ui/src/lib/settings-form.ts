import { PROFILE_NAME } from "@/lib/profile-form";
import { exceedsReasoning } from "@/lib/admission";
import type { ReasoningLevel, SettingsValues } from "@/lib/api/settings";

const MAX_ALLOWLIST = 100;
const MAX_ENTRY = 200;
const MAX_TURN_BUDGET = 1_000_000;

/** What the editor holds while an operator types: the list and the number are text until they are checked. */
export interface SettingsForm {
  defaultModel: string;
  allowlistText: string;
  /** Empty for "not set", which is sent as `null`. */
  reasoning: ReasoningLevel | "";
  maxReasoning: ReasoningLevel | "";
  defaultProfile: string;
  turnBudgetText: string;
}

export function formFromValues(values: SettingsValues): SettingsForm {
  return {
    defaultModel: values.defaultModel,
    allowlistText: values.allowlist.join("\n"),
    reasoning: values.reasoning ?? "",
    maxReasoning: values.maxReasoning ?? "",
    defaultProfile: values.defaultProfile,
    turnBudgetText: String(values.turnBudget),
  };
}

/** One model per line (commas work too). */
export function parseAllowlist(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Clearing reasoning or max reasoning gives `null`: the API reads an omitted field as "keep". */
export function valuesFromForm(form: SettingsForm): SettingsValues {
  return {
    defaultModel: form.defaultModel.trim(),
    allowlist: parseAllowlist(form.allowlistText),
    reasoning: form.reasoning === "" ? null : form.reasoning,
    maxReasoning: form.maxReasoning === "" ? null : form.maxReasoning,
    defaultProfile: form.defaultProfile,
    turnBudget: Number(form.turnBudgetText.trim() === "" ? Number.NaN : form.turnBudgetText),
  };
}

export function sameSettings(a: SettingsValues, b: SettingsValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isModelKey(entry: string): boolean {
  const slash = entry.indexOf("/");
  return slash > 0 && slash < entry.length - 1 && !/\s/.test(entry) && entry.length <= MAX_ENTRY;
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
  return problems;
}
