import type { ProfileDefinition } from "./profiles.js";

/**
 * How much of a session's old tool output is left out of the model's requests (docs/decisions/0067-trim-context.md).
 * `off`: none. `images`: old screenshots only. `full`: old screenshots and large old text results. The stored
 * transcript is never changed.
 */
export const CONTEXT_TRIMS = ["off", "images", "full"] as const;
export type ContextTrim = (typeof CONTEXT_TRIMS)[number];

export const isContextTrim = (value: unknown): value is ContextTrim =>
  typeof value === "string" && (CONTEXT_TRIMS as readonly string[]).includes(value);

/**
 * What a profile that sets none gets. Under the prompt-size gate trimming is a context-window tool and `full` (which
 * also elides text a coding agent needs for `edit`) is an opt-in per profile, so `images` for every flavour.
 */
export const defaultContextTrim = (): ContextTrim => "images";

/** The mode of a session: the profile's own, else the default. */
export const contextTrimOf = (
  definition: Pick<ProfileDefinition, "contextTrim"> | undefined,
): ContextTrim => definition?.contextTrim ?? defaultContextTrim();
