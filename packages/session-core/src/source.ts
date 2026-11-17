/**
 * The reserved `source` of a skill version or an MCP server: where a future catalog repository sync read it from
 * (docs/admin-ui-plan.md, "Later: a catalog repository"). Stored and returned, never part of a skill's digest and not
 * acted on by anything.
 */
export interface CatalogSource {
  /** A repository reference such as `github.com/acme/catalog` or a clone URL; no whitespace. */
  repository: string;
  /** The Git commit it was read at, lowercase hex. */
  commit: string;
}

const MAX_REPOSITORY = 200;
const REPOSITORY = /^[^\s\p{Cc}\p{Zl}\p{Zp}]+$/u;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** The source, or the message for a 400. Strict: exactly `repository` and `commit`. */
export function validateSource(input: unknown): CatalogSource | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "source must be an object with repository and commit";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "repository" && key !== "commit") {
      return `unknown source field "${key.slice(0, 50)}"`;
    }
  }
  const { repository, commit } = body;
  if (
    typeof repository !== "string" ||
    repository.length > MAX_REPOSITORY ||
    !REPOSITORY.test(repository) ||
    !repository.isWellFormed()
  ) {
    return `source.repository must be a string of 1 to ${String(MAX_REPOSITORY)} characters without whitespace or control characters`;
  }
  if (typeof commit !== "string" || !COMMIT.test(commit)) {
    return "source.commit must be a lowercase hex commit id of 7 to 64 characters";
  }
  return { repository, commit };
}

/** A stored `source` column, or null when empty or no longer valid (it is informational, so a bad row is not fatal). */
export function sourceFromColumn(value: unknown): CatalogSource | null {
  if (value === null || value === undefined) return null;
  const checked = validateSource(value);
  return typeof checked === "string" ? null : checked;
}

export function sourcesEqual(a: CatalogSource | null, b: CatalogSource | null): boolean {
  return a?.repository === b?.repository && a?.commit === b?.commit;
}
