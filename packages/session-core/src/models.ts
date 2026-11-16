/** A model a session runs on: a Pi provider id and a model id within it. */
export interface ModelChoice {
  provider: string;
  model: string;
  /** Reasoning effort (Pi's `thinkingLevel`); unset leaves it to Pi's default, `off`. */
  reasoning?: ThinkingLevel;
}

/** Lowest to highest, as pi-ai 1.5.2 orders them (its `ModelThinkingLevel`: `off` plus its `ThinkingLevel`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The level a string names, or undefined. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return THINKING_LEVELS.find((level) => level === value);
}

/** True if `level` is above `cap`. */
export function exceedsReasoning(level: ThinkingLevel, cap: ThinkingLevel): boolean {
  return THINKING_LEVELS.indexOf(level) > THINKING_LEVELS.indexOf(cap);
}

/** `provider/model`. The model id may itself contain slashes (`openrouter/openai/gpt-4.1-nano`). */
export function modelKey(choice: ModelChoice): string {
  return `${choice.provider}/${choice.model}`;
}

/** Parses one `provider/model` pair. Throws for anything else, naming the entry. */
export function parseModelKey(entry: string): ModelChoice {
  const slash = entry.indexOf("/");
  const provider = entry.slice(0, slash);
  const model = entry.slice(slash + 1);
  if (slash <= 0 || model === "" || /\s/.test(entry)) {
    throw new Error(`model allowlist entry "${entry}" is not provider/model`);
  }
  return { provider, model };
}

/** `PI_MODEL_ALLOWLIST`: comma- or newline-separated `provider/model` pairs. */
export function parseAllowlist(spec: string): ModelChoice[] {
  return spec
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(parseModelKey);
}

export const DEFAULT_MODEL: ModelChoice = { provider: "scripted", model: "scripted-1" };
export const DEFAULT_ALLOWLIST = "scripted/scripted-1,scripted/scripted-2";

export interface ModelPolicy {
  default: ModelChoice;
  /** The default is always allowed, so a session without a model field cannot be refused. */
  allowed: readonly ModelChoice[];
  /** The default reasoning effort of a session whose request names none; unset for none. */
  reasoning?: ThinkingLevel;
  /** Highest effort a request may ask for; unset for no cap. */
  maxReasoning?: ThinkingLevel;
}

export function loadModelPolicy(env: Readonly<Record<string, string | undefined>>): ModelPolicy {
  const reasoning = parseReasoning(env.PI_MODEL_REASONING);
  const defaultChoice: ModelChoice = {
    ...parseModelKey(
      `${env.PI_MODEL_PROVIDER ?? DEFAULT_MODEL.provider}/${env.PI_MODEL_ID ?? DEFAULT_MODEL.model}`,
    ),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
  const listed = parseAllowlist(env.PI_MODEL_ALLOWLIST ?? DEFAULT_ALLOWLIST);
  const seen = new Set<string>();
  const allowed = [defaultChoice, ...listed].filter((choice) => {
    const key = modelKey(choice);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { default: defaultChoice, allowed, ...(reasoning === undefined ? {} : { reasoning }) };
}

function parseReasoning(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined || value === "") return undefined;
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`PI_MODEL_REASONING must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return level;
}

/**
 * The `reasoning` field of a `POST /sessions` body: `{}` when absent, else the validated level. A string is the 400
 * message. Whether the model supports reasoning is not checked here: ingest has no model catalog (docs/session-api.md).
 */
function requestedReasoning(
  policy: ModelPolicy,
  body: Record<string, unknown>,
): { level?: ThinkingLevel } | string {
  if (body.reasoning === undefined) return {};
  const level = parseThinkingLevel(body.reasoning);
  if (level === undefined) return `reasoning must be one of ${THINKING_LEVELS.join(", ")}`;
  if (policy.maxReasoning !== undefined && exceedsReasoning(level, policy.maxReasoning)) {
    return `reasoning ${level} is above the allowed maximum ${policy.maxReasoning}`;
  }
  return { level };
}

/**
 * The model for a new session: the default when the body names none, else the requested pair if the allowlist has
 * it. A string is the 400 message.
 */
export function chooseModel(
  policy: ModelPolicy,
  body: Record<string, unknown>,
): ModelChoice | string {
  const { provider, model } = body;
  const asked = requestedReasoning(policy, body);
  if (typeof asked === "string") return asked;
  const reasoning = asked.level ?? policy.reasoning;
  const withReasoning = reasoning === undefined ? {} : { reasoning };
  if (provider === undefined && model === undefined) {
    return { provider: policy.default.provider, model: policy.default.model, ...withReasoning };
  }
  if (
    typeof provider !== "string" ||
    typeof model !== "string" ||
    provider === "" ||
    model === ""
  ) {
    return "provider and model must both be non-empty strings";
  }
  const requested: ModelChoice = { provider, model, ...withReasoning };
  // Compare the pair, not the joined key: `a/b` + `c` and `a` + `b/c` join to the same string but are
  // different pairs (a provider id never contains a slash, a model id may).
  if (!policy.allowed.some((choice) => choice.provider === provider && choice.model === model)) {
    return `model ${modelKey(requested).slice(0, 200)} is not allowed`;
  }
  return requested;
}
