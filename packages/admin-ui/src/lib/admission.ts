import type { InvalidProfile, ProfileDefinition } from "@/lib/api/profiles";
import { REASONING_LEVELS } from "@/lib/api/settings";
import type { ReasoningLevel, SettingsValues } from "@/lib/api/settings";

/**
 * What a new session would get from a profile, and whether it would be admitted at all. The rules are the ones ingest
 * applies in `POST /sessions`, with no caller overrides (no `provider`, `model` or `reasoning` in the request):
 *
 * - `chooseProfile` (packages/ingest/src/server.ts): the profile must exist, be valid and be enabled for new sessions.
 *   A default that fails is a 503, a requested one a 400.
 * - `postSession` (same file): the profile's `defaultModel` and `reasoning` stand in for the request's, then
 *   `chooseModel` runs on them. Precedence is request, profile, settings; here, profile, settings.
 * - `chooseModel` and `requestedReasoning` (packages/session-core/src/models.ts): the reasoning must not exceed
 *   `maxReasoning` and is checked first; the model must be on the allowlist. A setting's own `reasoning` is not checked
 *   again, because `validateSettings` (settings.ts) already refuses one above `maxReasoning`.
 * - `policyOf` and `validateSettings` (packages/session-core/src/settings.ts): the allowlist has the default model first
 *   and always, so a session without a model cannot be refused.
 * - The turn budget is `definition.turnBudget ?? settings.turnBudget` (packages/orchestrator/src/sessions.ts).
 *
 * Provider availability, credentials and whether the model supports reasoning are only known at the first turn, so the
 * preview cannot show them.
 */

export interface ProfileSubject {
  name: string;
  enabledForNew: boolean;
  definition: ProfileDefinition;
  /** The version a session would store; shown in the refusal like ingest does. */
  version: number;
}

export interface Admitted {
  ok: true;
  model: string;
  modelFrom: "profile" | "settings";
  reasoning: ReasoningLevel | null;
  reasoningFrom: "profile" | "settings" | "none";
  turnBudget: number;
  turnBudgetFrom: "profile" | "settings";
}

export type RefusalKind = "missing" | "invalid" | "disabled" | "model" | "reasoning";

export interface Refused {
  ok: false;
  kind: RefusalKind;
  /** What ingest would answer (without the `the default profile` prefix of a 503). */
  message: string;
  /** What the operator can do about it. */
  fix: string;
}

export type Admission = Admitted | Refused;

/** The allowlist ingest enforces: the default model first, duplicates dropped (`validateSettings`). */
export function effectiveAllowlist(settings: SettingsValues): string[] {
  return [...new Set([settings.defaultModel, ...settings.allowlist])];
}

/** True if `a` is above `cap` (`exceedsReasoning`). */
export function exceedsReasoning(level: ReasoningLevel, cap: ReasoningLevel): boolean {
  return REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf(cap);
}

export function admit(settings: SettingsValues, profile: ProfileSubject): Admission {
  const { definition } = profile;
  const tag = `profile "${profile.name}" v${String(profile.version)}`;
  if (!profile.enabledForNew) {
    return {
      ok: false,
      kind: "disabled",
      message: `profile "${profile.name}" is not available for new sessions`,
      fix: `Enable "${profile.name}" for new sessions, or choose another profile.`,
    };
  }
  const reasoning = definition.reasoning ?? settings.reasoning ?? null;
  // Only a level that comes from the profile is checked against the cap, as in `requestedReasoning`.
  if (
    definition.reasoning !== undefined &&
    settings.maxReasoning !== null &&
    exceedsReasoning(definition.reasoning, settings.maxReasoning)
  ) {
    return {
      ok: false,
      kind: "reasoning",
      message: `${tag}: reasoning ${definition.reasoning} is above the allowed maximum ${settings.maxReasoning}`,
      fix: `Lower the profile's reasoning to ${settings.maxReasoning} or below, or raise max reasoning in the global settings.`,
    };
  }
  const model = definition.defaultModel ?? settings.defaultModel;
  if (definition.defaultModel !== undefined && !effectiveAllowlist(settings).includes(model)) {
    return {
      ok: false,
      kind: "model",
      message: `${tag}: model ${model} is not allowed`,
      fix: `Add ${model} to the allowlist in the global settings, or change the profile's model.`,
    };
  }
  return {
    ok: true,
    model,
    modelFrom: definition.defaultModel === undefined ? "settings" : "profile",
    reasoning,
    reasoningFrom:
      definition.reasoning !== undefined
        ? "profile"
        : settings.reasoning === null
          ? "none"
          : "settings",
    turnBudget: definition.turnBudget ?? settings.turnBudget,
    turnBudgetFrom: definition.turnBudget === undefined ? "settings" : "profile",
  };
}

export interface ProfileFacts {
  name: string;
  enabledForNew: boolean;
  definition: ProfileDefinition;
  currentVersion: number;
}

/** What the default profile of `settings` would do to a new session, given the profiles that exist. */
export function admitDefault(
  settings: SettingsValues,
  profiles: readonly ProfileFacts[],
  invalid: readonly InvalidProfile[],
): Admission {
  const name = settings.defaultProfile;
  if (invalid.some((entry) => entry.name === name)) {
    return {
      ok: false,
      kind: "invalid",
      message: `the default profile "${name}" is invalid`,
      fix: `Publish a valid definition for "${name}", or select another profile as the default.`,
    };
  }
  const found = profiles.find((profile) => profile.name === name);
  if (found === undefined) {
    return {
      ok: false,
      kind: "missing",
      message: `the default profile "${name}" does not exist`,
      fix: `Create a profile named "${name}", or select an existing one as the default.`,
    };
  }
  const result = admit(settings, subject(found));
  return result.ok
    ? result
    : {
        ...result,
        message:
          result.kind === "disabled"
            ? `the default profile "${name}" is not available for new sessions`
            : result.message,
      };
}

function subject(profile: ProfileFacts): ProfileSubject {
  return {
    name: profile.name,
    enabledForNew: profile.enabledForNew,
    definition: profile.definition,
    version: profile.currentVersion,
  };
}

export interface ProfileFailure {
  name: string;
  refused: Refused;
}

/** The enabled profiles other than `except` that new sessions would be refused for under `settings`. */
export function failingProfiles(
  settings: SettingsValues,
  profiles: readonly ProfileFacts[],
  except?: string,
): ProfileFailure[] {
  const failures: ProfileFailure[] = [];
  for (const profile of profiles) {
    if (!profile.enabledForNew || profile.name === except) continue;
    const result = admit(settings, subject(profile));
    if (!result.ok) failures.push({ name: profile.name, refused: result });
  }
  return failures;
}

export interface SaveReview {
  /** Set when the save must be corrected first: the selected default profile would fail admission. */
  blocking: Refused | undefined;
  /** Other enabled profiles that would fail: a warning only, they fail only when chosen. */
  warnings: ProfileFailure[];
}

/**
 * The review of a settings save: the default profile blocks, the others warn. With `before` (the stored settings), a
 * profile that was refused already is left out: only what this change breaks is news.
 */
export function reviewSettingsSave(
  next: SettingsValues,
  profiles: readonly ProfileFacts[],
  invalid: readonly InvalidProfile[],
  before?: SettingsValues,
): SaveReview {
  const result = admitDefault(next, profiles, invalid);
  const already = new Set(
    before === undefined ? [] : failingProfiles(before, profiles).map((entry) => entry.name),
  );
  return {
    blocking: result.ok ? undefined : result,
    warnings: failingProfiles(next, profiles, next.defaultProfile).filter(
      (entry) => !already.has(entry.name),
    ),
  };
}

/**
 * The review of a profile save: `draft` replaces the stored profile of that name (or adds it) under the current
 * settings. When it is the default profile it blocks; as any other enabled profile it warns.
 */
export function reviewProfileSave(
  settings: SettingsValues,
  draft: ProfileFacts,
): { blocking: Refused | undefined; warnings: ProfileFailure[]; admission: Admission } {
  const admission = admit(settings, subject(draft));
  const isDefault = settings.defaultProfile === draft.name;
  if (admission.ok) return { blocking: undefined, warnings: [], admission };
  if (isDefault) {
    return {
      blocking: {
        ...admission,
        fix: `${admission.fix} "${draft.name}" is the default profile, so every session without a profile would be refused.`,
      },
      warnings: [],
      admission,
    };
  }
  return {
    blocking: undefined,
    warnings: [{ name: draft.name, refused: admission }],
    admission,
  };
}
