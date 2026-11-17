/**
 * Optimistic concurrency for the admin writes (docs/decisions/0023-admin-revisions.md). A write may carry
 * `expectedRevision`; a stored resource whose revision differs, or that does not exist, refuses it. The transaction
 * is rolled back, so nothing changes.
 */

/** A write that the stored state refuses; the admin API answers it with 409. Thrown inside a transaction to roll it back. */
export class AdminConflictError extends Error {}

/** `expectedRevision` of a body: a positive integer, undefined when absent, or the message for a 400. */
export function parseExpectedRevision(value: unknown): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    return "expectedRevision must be a positive integer";
  }
  return value;
}

/** Throws when `expected` is given and is not the stored revision (`undefined` when there is no row). */
export function checkRevision(
  what: string,
  expected: number | undefined,
  stored: number | undefined,
): void {
  if (expected === undefined || expected === stored) return;
  throw new AdminConflictError(
    stored === undefined
      ? `${what} does not exist, so expectedRevision ${String(expected)} cannot match`
      : `${what} is at revision ${String(stored)}, not the expected ${String(expected)}: reload and retry`,
  );
}
