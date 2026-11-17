import { ApiError } from "@/lib/api";

/**
 * Why a write got `409` (docs/decisions/0023-admin-revisions.md). Both answers change nothing.
 * - `stale`: the resource moved on since the draft was loaded (`checkRevision`, packages/session-core/src/revision.ts).
 * - `default-profile`: the profile is the default for new sessions and cannot be disabled (`putProfile`).
 */
export type ConflictKind = "stale" | "default-profile";

export function conflictKind(error: ApiError): ConflictKind {
  return /default profile for new sessions/.test(error.message) ? "default-profile" : "stale";
}
