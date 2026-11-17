/** The limits of a skill version (packages/session-core/src/skills.ts). Pre-checks only: the API is the authority. */
export const SKILL_LIMITS = {
  description: 1024,
  skillMd: 32 * 1024,
  files: 128,
  bytes: 5 * 1024 * 1024,
  path: 200,
} as const;

export const SKILL_ENTRY = "SKILL.md";
export const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** A path segment: no leading dot, no spaces, nothing a shell would read. */
export const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
