import type { ProfileDefinition } from "@/lib/api/profiles";
import type { SettingsValues } from "@/lib/api/settings";

/** One field that differs. Values are display text: an absent field is not the same as an empty one. */
export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export const OMITTED = "(omitted)";

function show(value: unknown): string {
  if (value === undefined) return OMITTED;
  if (value === null) return "(not set)";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty list)";
    return value.map((entry) => show(entry)).join(", ");
  }
  if (typeof value === "object") {
    const pin = value as { name?: unknown; version?: unknown };
    if (typeof pin.name === "string" && typeof pin.version === "number")
      return `${pin.name}@v${String(pin.version)}`;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Skill pins compare by name and version: the API fills in `digest`, which a draft may not have yet. */
function pinKey(skills: ProfileDefinition["skills"]): unknown {
  return skills?.map((pin) => ({ name: pin.name, version: pin.version }));
}

const DEFINITION_FIELDS = [
  "instructions",
  "tools",
  "modelTools",
  "defaultModel",
  "reasoning",
  "turnBudget",
  "mcpServers",
  "skills",
  "repoSkills",
  "repoContext",
] as const;

/** The fields that differ between two stored definitions, in the order of the editor. */
export function diffDefinitions(
  before: ProfileDefinition,
  after: ProfileDefinition,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of DEFINITION_FIELDS) {
    const a = field === "skills" ? pinKey(before.skills) : before[field];
    const b = field === "skills" ? pinKey(after.skills) : after[field];
    if (!sameValue(a, b)) changes.push({ field, before: show(a), after: show(b) });
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
] as const;

/** The settings fields that differ; `before` is null for the seed entry, whose fields all show as new. */
export function diffSettings(before: SettingsValues | null, after: SettingsValues): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of SETTINGS_FIELDS) {
    const a = before === null ? undefined : before[field];
    const b = after[field];
    if (!sameValue(a, b)) changes.push({ field, before: show(a), after: show(b) });
  }
  return changes;
}
