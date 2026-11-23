import type { ProfileDefinition } from "./profiles.js";
import type { SandboxFlavour } from "./sandbox-flavour.js";

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
 * What a profile that sets none gets: `full` for the flavours whose sessions read pages and screens (browser, desktop),
 * `images` for the default flavour, where a coding agent needs its old file reads and diffs for `edit`.
 */
export const defaultContextTrim = (flavour: SandboxFlavour): ContextTrim =>
  flavour === "default" ? "images" : "full";

/** The mode of a session: the profile's own, else the default of its flavour. */
export const contextTrimOf = (
  definition: Pick<ProfileDefinition, "contextTrim"> | undefined,
  flavour: SandboxFlavour,
): ContextTrim => definition?.contextTrim ?? defaultContextTrim(flavour);
