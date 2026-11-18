import type { ProfileDefinition } from "@/lib/api/profiles";
import type { SettingsValues } from "@/lib/api/settings";
import { fieldLabel } from "@/lib/field-labels";

/** One field that differs. `field` is the API key; `before` and `after` are display text. */
export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

function list(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.join(", ");
}

/** What a stored profile field means to a person, including what an absent field stands for. */
function showProfile(
  field: (typeof DEFINITION_FIELDS)[number],
  definition: ProfileDefinition,
): string {
  switch (field) {
    case "tools":
    case "modelTools": {
      const names = definition[field];
      return names === undefined ? "all tools" : list(names, "no tools");
    }
    case "mcpServers":
      return list(definition.mcpServers ?? [], "none");
    case "skills":
      return list(
        (definition.skills ?? []).map((pin) => `${pin.name}@v${String(pin.version)}`),
        "none",
      );
    case "repoSkills":
    case "repoContext":
      return definition[field] === true ? "on" : "off";
    case "instructions":
      return definition.instructions ?? "none";
    case "defaultModel":
    case "reasoning":
    case "turnBudget":
    case "tokenBudget":
      return String(definition[field] ?? "global default");
  }
}

const DEFINITION_FIELDS = [
  "instructions",
  "tools",
  "modelTools",
  "defaultModel",
  "reasoning",
  "turnBudget",
  "tokenBudget",
  "mcpServers",
  "skills",
  "repoSkills",
  "repoContext",
] as const;

/** The fields that differ between two stored definitions, in the order of the editor. A change of spelling alone is none. */
export function diffDefinitions(
  before: ProfileDefinition,
  after: ProfileDefinition,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of DEFINITION_FIELDS) {
    const a = showProfile(field, before);
    const b = showProfile(field, after);
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

const SETTINGS_FIELDS = [
  "defaultModel",
  "allowlist",
  "reasoning",
  "maxReasoning",
  "defaultProfile",
  "turnBudget",
  "tokenBudget",
  "repoAllowlist",
] as const;

function showSetting(field: (typeof SETTINGS_FIELDS)[number], values: SettingsValues): string {
  switch (field) {
    case "allowlist":
      // Order carries no meaning, so a reordering is not a change.
      return list([...values.allowlist].sort(), "none");
    case "reasoning":
      return values.reasoning ?? "model default";
    case "maxReasoning":
      return values.maxReasoning ?? "no limit";
    case "tokenBudget":
      // History rows written before the field existed lack it: no limit then too.
      return String(values.tokenBudget ?? "no limit");
    case "repoAllowlist": {
      // History rows written before the field existed lack it: none then, as now for an empty list.
      const repos = (values as Partial<SettingsValues>).repoAllowlist ?? [];
      return list([...repos].sort(), "none (repo sessions refused)");
    }
    default:
      return String(values[field]);
  }
}

/** The settings fields that differ; `before` is null for the seed entry, whose fields all show as new. */
export function diffSettings(before: SettingsValues | null, after: SettingsValues): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of SETTINGS_FIELDS) {
    const b = showSetting(field, after);
    if (before === null) {
      changes.push({ field, before: "", after: b });
      continue;
    }
    const a = showSetting(field, before);
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

/** "Default model, Allowed models": the names of the fields a change touched. */
export const changedNames = (changes: readonly FieldChange[]): string =>
  changes.map((change) => fieldLabel(change.field)).join(", ");
