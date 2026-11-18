# 0027: Deleting session profiles, skills and MCP servers

Status: accepted, 2026-11-18 (issue #174). Amends [0009](0009-mcp-catalog-in-postgres.md),
[0010](0010-session-profiles.md), [0011](0011-skills-in-postgres.md) and [0023](0023-admin-revisions.md).

## Context

Profiles and skills could not be deleted at all (versions are the audit trail), and an MCP server's DELETE removed the
row without looking at what used it. Operators need to remove what they no longer want, and a delete must never break a
running session or let an old name come to mean something else:

- A session reads its pinned skill files from Postgres at every sandbox attach (`packages/orchestrator/src/skills.ts`):
  a missing version throws `SkillIntegrityError`.
- A conversation stores MCP server names and resolves them by name (`mcp-<name>`): a server created again under a
  deleted name was picked up by old conversations.
- Sessions keep a snapshot of their profile definition; the orchestrator never reads the live profile for a running
  session.

A retire tombstone (rows stay, hidden) was considered and rejected by the operator in favour of a real delete. The
design below was reviewed by two models for safety and for doing no more than needed.

## Decision

- **A delete removes the rows, only while nothing live refers to them.** No `force`, no cascade: disabling is the lever
  for an emergency.

  | | Refused (`409`) while | Removed |
  |---|---|---|
  | Profile | it is the effective default (`default_profile`, or `coding` when unset) or still `enabledForNew` (disable first) | the profile and every version |
  | Skill | a profile's current version pins it (enabled or not), or a session with `status <> 'deleted'` pins it | the skill, every version and file |
  | MCP server | a profile's current version names it | the row (its history row stays) |

  Sessions never block a profile delete (they run on their snapshot) or an MCP delete (their calls settle
  `tool_unavailable`, ADR 0009). They block a skill delete, failed and deleting ones included, because the files are
  read at attach.
- **A deleted name is never used again.** `inbox.deleted_names (kind, name, last_version, deleted_at, deleted_by)`
  records it; a create under that name is `409`. So `{name, version}` in old sessions keeps one meaning, and no old
  conversation reattaches to a new server, without generations or version high-water marks. The same table is the
  audit of who deleted what. A profile publish that names a deleted MCP server is `400`, checked under the lock below,
  so a catalog read from before the delete cannot slip through.
- **One lock.** Every write that changes what refers to what (profile publish, enable and disable, skill publish, MCP
  create and update, the three deletes) takes the advisory transaction lock `catalog` exclusively, before any other lock
  it takes. Session creation takes it shared and inserts the session only if the profile is still at the snapshot's
  version and open to new sessions (`StaleProfileError`, a `409` "retry"). Creations do not wait for each other; a
  delete sees every session that was committed, and no session can pin what a delete removes.
- **`expectedRevision` is required on a DELETE**, as `?expectedRevision=N` (`400` without it): the caller proves it saw
  the current state. For a skill it is the current version (versions never change, so skills need no revision column).
  A missing resource is `404`, so a retried delete reads as done.
- **The `409` names what blocks it:** `{ error, blockedBy: { profiles?: [{name, version}], sessions?: { count, sample },
  defaultProfile?: true, enabledForNew?: true } }`, with at most five session ids. There is no separate dry-run route.
- **Version rows stay immutable.** The triggers of migrations 008 and 010 allow a DELETE only when the transaction set
  `pi.allow_delete` (`set local`), which only the delete path does after its checks; UPDATE is always refused. It
  guards against mistakes, not against a role that may set the setting.

## Consequences

- A delete cannot be undone: the content is gone and the name is taken for good.
- A skill pinned by another owner's idle session cannot be deleted until that session is deleted; admins cannot delete
  other owners' sessions (a separate authorization feature, not done).
- A session creation that loses the race to a publish or a delete gets a `409` and retries.
- Profile deletion and enable/disable leave no history row beyond `deleted_names` (as before for enable/disable).
- The console offers no delete yet; that is a later change.
