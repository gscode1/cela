import type { ProfileDefinition, SkillInfo, SkillPin } from "@/lib/api/profiles";
import { REASONING_LEVELS } from "@/lib/api/settings";
import type { ReasoningLevel } from "@/lib/api/settings";

/** `PROFILE_NAME` (packages/session-core/src/profiles.ts). */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `profileNameError` (packages/session-core/src/profiles.ts): the message for a name that cannot be a profile's. */
export function profileNameProblem(name: string): string | undefined {
  if (!PROFILE_NAME.test(name)) {
    return "Names start with a letter and use lowercase letters, digits and hyphens, at most 32 characters.";
  }
  // `/profiles/new` is the create route.
  return name === "new" ? 'The name "new" is reserved.' : undefined;
}
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** `SANDBOX_SIZE_NAME` (packages/session-core/src/sandbox-sizes.ts). */
const SANDBOX_SIZE_NAME = /^[a-z][a-z0-9-]{0,15}$/;
const MAX_LIST = 32;
const MAX_SKILLS = 20;
const MAX_INSTRUCTIONS = 8_000;
const MAX_TURN_BUDGET = 1_000_000;
const MAX_TOKEN_BUDGET = 1_000_000_000_000;
const MAX_MODEL = 200;

/**
 * What the editor holds while an operator types. It keeps what a definition cannot say on its own: "all tools" is an
 * absent `tools`, and an empty selection is the empty list, which is a different profile.
 */
export interface ProfileForm {
  instructions: string;
  allTools: boolean;
  tools: string[];
  allModelTools: boolean;
  modelTools: string[];
  defaultModel: string;
  /** Empty for no override; `off` is an override. */
  reasoning: ReasoningLevel | "";
  turnBudget: string;
  tokenBudget: string;
  mcpServers: string[];
  skills: SkillPin[];
  repoSkills: boolean;
  repoContext: boolean;
  /** Empty for the deployment default. */
  sandboxSize: string;
  sandboxSizes: string[];
}

export function formFromDefinition(definition: ProfileDefinition): ProfileForm {
  return {
    instructions: definition.instructions ?? "",
    allTools: definition.tools === undefined,
    tools: definition.tools ?? [],
    allModelTools: definition.modelTools === undefined,
    modelTools: definition.modelTools ?? [],
    defaultModel: definition.defaultModel ?? "",
    reasoning: definition.reasoning ?? "",
    turnBudget: definition.turnBudget === undefined ? "" : String(definition.turnBudget),
    tokenBudget: definition.tokenBudget === undefined ? "" : String(definition.tokenBudget),
    mcpServers: definition.mcpServers ?? [],
    skills: definition.skills ?? [],
    repoSkills: definition.repoSkills ?? false,
    repoContext: definition.repoContext ?? false,
    sandboxSize: definition.sandboxSize ?? "",
    sandboxSizes: definition.sandboxSizes ?? [],
  };
}

/**
 * The definition a form stands for. A cleared override (model, reasoning, turn or token budget, instructions) is left out, never
 * sent as an empty value. `original` is the definition the form started from: where the form says "none" and the original
 * said it with an explicit empty list or `false`, that spelling is kept, so an edit elsewhere does not create a version
 * through a mere change of spelling.
 */
export function definitionFromForm(
  form: ProfileForm,
  original: ProfileDefinition = {},
): ProfileDefinition {
  const definition: ProfileDefinition = {};
  if (!form.allTools) definition.tools = form.tools;
  if (!form.allModelTools) definition.modelTools = form.modelTools;
  if (form.instructions.trim() !== "") definition.instructions = form.instructions;
  if (form.defaultModel.trim() !== "") definition.defaultModel = form.defaultModel.trim();
  if (form.reasoning !== "") definition.reasoning = form.reasoning;
  if (form.turnBudget.trim() !== "") definition.turnBudget = Number(form.turnBudget.trim());
  if (form.tokenBudget.trim() !== "") definition.tokenBudget = Number(form.tokenBudget.trim());
  if (form.mcpServers.length > 0 || original.mcpServers !== undefined)
    definition.mcpServers = form.mcpServers;
  // The API drops an empty `skills`, so it is never sent.
  if (form.skills.length > 0) definition.skills = form.skills;
  if (form.repoSkills || original.repoSkills !== undefined) definition.repoSkills = form.repoSkills;
  if (form.repoContext || original.repoContext !== undefined)
    definition.repoContext = form.repoContext;
  if (form.sandboxSize !== "") definition.sandboxSize = form.sandboxSize;
  if (form.sandboxSizes.length > 0 || original.sandboxSizes !== undefined)
    definition.sandboxSizes = form.sandboxSizes;
  return definition;
}

/**
 * The messages the API would answer with `400` for a definition (`validateProfileDefinition`,
 * packages/session-core/src/profiles.ts), so the editor can say so before saving. Names are checked against reality
 * separately (`referenceProblems`).
 */
export function definitionProblems(definition: ProfileDefinition): string[] {
  const problems: string[] = [];
  for (const field of ["tools", "modelTools"] as const) {
    const list = definition[field];
    if (list === undefined) continue;
    if (list.length > MAX_LIST || !list.every((name) => TOOL_NAME.test(name)))
      problems.push(`${field} must be an array of at most ${String(MAX_LIST)} tool names`);
  }
  if (definition.tools !== undefined && definition.modelTools !== undefined) {
    const enabled = definition.tools;
    const outside = definition.modelTools.find((name) => !enabled.includes(name));
    if (outside !== undefined) problems.push(`modelTools "${outside}" is not in tools`);
  }
  const text = definition.instructions;
  if (text !== undefined) {
    if (
      text.trim() === "" ||
      text.length > MAX_INSTRUCTIONS ||
      text.includes("\u0000") ||
      !text.isWellFormed()
    )
      problems.push(
        `instructions must be a non-empty string of at most ${String(MAX_INSTRUCTIONS)} characters`,
      );
  }
  const model = definition.defaultModel;
  if (model !== undefined) {
    const slash = model.indexOf("/");
    if (model.length > MAX_MODEL || slash <= 0 || slash === model.length - 1 || /\s/.test(model))
      problems.push(`defaultModel "${model.slice(0, 80)}" is not provider/model`);
  }
  if (definition.reasoning !== undefined && !REASONING_LEVELS.includes(definition.reasoning))
    problems.push(`reasoning must be one of ${REASONING_LEVELS.join(", ")}`);
  const budget = definition.turnBudget;
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > MAX_TURN_BUDGET))
    problems.push(`turnBudget must be an integer from 1 to ${String(MAX_TURN_BUDGET)}`);
  const tokens = definition.tokenBudget;
  if (
    tokens !== undefined &&
    (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_TOKEN_BUDGET)
  )
    problems.push(`tokenBudget must be an integer from 1 to ${String(MAX_TOKEN_BUDGET)}`);
  const servers = definition.mcpServers;
  if (
    servers !== undefined &&
    (servers.length > MAX_LIST || !servers.every((name) => MCP_SERVER_NAME.test(name)))
  )
    problems.push("mcpServers must be an array of MCP server names");
  if (definition.sandboxSize !== undefined && !SANDBOX_SIZE_NAME.test(definition.sandboxSize))
    problems.push("sandboxSize must be a size name");
  const sizes = definition.sandboxSizes;
  if (
    sizes !== undefined &&
    (sizes.length > MAX_LIST || !sizes.every((name) => SANDBOX_SIZE_NAME.test(name)))
  )
    problems.push("sandboxSizes must be an array of size names");
  if (definition.skills !== undefined && definition.skills.length > MAX_SKILLS)
    problems.push(`skills must be an array of at most ${String(MAX_SKILLS)} entries`);
  problems.push(...readProblems(definition));
  return problems;
}

/**
 * Skills and repository skills are loaded by reading their `SKILL.md`, so an explicit tool list that lacks `read`
 * is refused. The editor explains and leaves the lists to the operator.
 */
export function readProblems(definition: ProfileDefinition): string[] {
  const problems: string[] = [];
  const needs: [string, boolean][] = [
    ["skills", (definition.skills?.length ?? 0) > 0],
    ["repoSkills", definition.repoSkills === true],
  ];
  for (const [what, active] of needs) {
    if (!active) continue;
    for (const field of ["tools", "modelTools"] as const) {
      const list = definition[field];
      if (list !== undefined && !list.includes("read"))
        problems.push(
          `${what} ${what === "skills" ? "need" : "needs"} the read tool, but ${field} does not include it`,
        );
    }
  }
  return problems;
}

export interface Catalog {
  tools: readonly string[];
  mcpServers: readonly { name: string; enabled: boolean }[];
}

export interface ReferenceProblems {
  /** Tool names the orchestrator does not have; the API refuses a new version with them. */
  unknownTools: { field: "tools" | "modelTools"; name: string }[];
  /** MCP servers that are not in the catalog (deleted); the API refuses a new version with them. */
  missingServers: string[];
  /** MCP servers that exist but are disabled: they save, and their tools are unavailable until enabled. */
  disabledServers: string[];
}

/** `checkProfileNames` (packages/session-core/src/profiles.ts), listing every problem instead of the first. */
export function referenceProblems(
  definition: ProfileDefinition,
  known: Catalog,
): ReferenceProblems {
  const unknownTools: ReferenceProblems["unknownTools"] = [];
  for (const field of ["tools", "modelTools"] as const)
    for (const name of definition[field] ?? [])
      if (!known.tools.includes(name)) unknownTools.push({ field, name });
  const missingServers: string[] = [];
  const disabledServers: string[] = [];
  for (const name of definition.mcpServers ?? []) {
    const server = known.mcpServers.find((entry) => entry.name === name);
    if (server === undefined) missingServers.push(name);
    else if (!server.enabled) disabledServers.push(name);
  }
  return { unknownTools, missingServers, disabledServers };
}

/** Removes the references the API would refuse, so the operator can accept the offer in one click. */
export function withoutBrokenReferences(
  form: ProfileForm,
  problems: ReferenceProblems,
): ProfileForm {
  const unknown = (field: "tools" | "modelTools"): Set<string> =>
    new Set(
      problems.unknownTools.filter((entry) => entry.field === field).map((entry) => entry.name),
    );
  const unknownTools = unknown("tools");
  const unknownModelTools = unknown("modelTools");
  return {
    ...form,
    tools: form.tools.filter((name) => !unknownTools.has(name)),
    modelTools: form.modelTools.filter((name) => !unknownModelTools.has(name)),
    mcpServers: form.mcpServers.filter((name) => !problems.missingServers.includes(name)),
  };
}

/** The pinned skills that ship executable files while an explicit tool list leaves the model without `bash`. */
export function executableSkillsWithoutBash(
  definition: ProfileDefinition,
  skills: readonly SkillInfo[],
): string[] {
  const noBash = [definition.tools, definition.modelTools].some(
    (list) => list !== undefined && !list.includes("bash"),
  );
  if (!noBash) return [];
  const found: string[] = [];
  for (const pin of definition.skills ?? []) {
    const version = skills
      .find((skill) => skill.name === pin.name)
      ?.versions.find((candidate) => candidate.version === pin.version);
    if (version?.files.some((file) => file.executable) === true) found.push(pin.name);
  }
  return found;
}

/** True when the form says nothing: the profile then inherits everything from the global settings. */
export function isEmptyForm(form: ProfileForm): boolean {
  return (
    form.instructions.trim() === "" &&
    form.allTools &&
    form.allModelTools &&
    form.defaultModel.trim() === "" &&
    form.reasoning === "" &&
    form.turnBudget.trim() === "" &&
    form.tokenBudget.trim() === "" &&
    form.mcpServers.length === 0 &&
    form.skills.length === 0 &&
    !form.repoSkills &&
    !form.repoContext &&
    form.sandboxSize === "" &&
    form.sandboxSizes.length === 0
  );
}

/** The host of an MCP server's URL, for lists; the full URL stays available for a title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
