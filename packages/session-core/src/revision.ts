/**
 * Optimistic concurrency for the admin writes (docs/decisions/0023-admin-revisions.md). A write may carry
 * `expectedRevision`; a stored resource whose revision differs, or that does not exist, refuses it. The transaction
 * is rolled back, so nothing changes.
 */

/** A write that the stored state refuses; the admin API answers it with 409. Thrown inside a transaction to roll it back. */
export class AdminConflictError extends Error {}

/**
 * The `expectedRevision` of a create-only write: the resource must not exist yet. Stored revisions start at 1, so it
 * matches no row.
 */
export const CREATE_ONLY_REVISION = 0;

/**
 * `expectedRevision` of a body: a positive integer, undefined when absent, or the message for a 400. With `create`,
 * also `CREATE_ONLY_REVISION`, for the writes that can create (a profile or MCP server PUT).
 */
export function parseExpectedRevision(
  value: unknown,
  options: { create?: boolean } = {},
): number | undefined | string {
  if (value === undefined) return undefined;
  const create = options.create === true;
  const least = create ? CREATE_ONLY_REVISION : 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < least ||
    value > 2_147_483_647
  ) {
    return create
      ? "expectedRevision must be 0 (create only) or a positive integer"
      : "expectedRevision must be a positive integer";
  }
  return value;
}

/**
 * Throws when `expected` is given and is not the stored revision (`undefined` when there is no row).
 * `CREATE_ONLY_REVISION` matches only the absent row.
 */
export function checkRevision(
  what: string,
  expected: number | undefined,
  stored: number | undefined,
): void {
  if (expected === undefined || expected === (stored ?? CREATE_ONLY_REVISION)) return;
  throw new AdminConflictError(
    expected === CREATE_ONLY_REVISION
      ? `${what} already exists: choose another name`
      : stored === undefined
        ? `${what} does not exist, so expectedRevision ${String(expected)} cannot match`
        : `${what} is at revision ${String(stored)}, not the expected ${String(expected)}: reload and retry`,
  );
}
