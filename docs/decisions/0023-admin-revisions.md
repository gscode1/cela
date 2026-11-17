# 0023: the default profile is guarded inside the write, and admin writes may carry a revision

Status: accepted, 2026-11-17 (issue #144). Backend part of slice 2 of the [admin UI plan](../admin-ui-plan.md).

## Context

`PUT /admin/settings` checked `defaultProfile` before its write transaction, and disabling a profile never looked at the
settings. Two admins (or two requests) could therefore leave a disabled default, which fails every `POST /sessions` without
a `profile` with `503`. Separately, two admins editing one resource overwrote each other without notice, and an admin UI
needs to detect that. The console also needs a few reads and reserved fields that the API did not have.

## Decision

- **One lock, inside the transactions.** `updateSettings` and `putProfile` take the transaction-scoped advisory lock
  `settings:default-profile` (`DEFAULT_PROFILE_LOCK`). `updateSettings` checks a given `defaultProfile` (it exists, is valid
  and is enabled for new sessions) after the lock and before it writes. `putProfile` takes it, after the per-name lock, only
  when the body disables a profile, and reads the settings' default under it. The order is always profile lock, then
  default lock, and settings writes take only the second, so there is no cycle. Under read committed, whoever gets the lock
  second sees the other's committed change, so exactly one of "select X" and "disable X" wins.
- **Status codes.** Selecting a disabled, missing or invalid default stays `400` (the value is bad, as before). Disabling
  the current default is `409`: the request is well formed and the stored state refuses it, like the existing `409` for an
  invalid current profile version. A profile that is already disabled and the default (a row edited by hand) can still be
  written; it just cannot be disabled again.
- **Revisions.** A `revision integer not null default 1` column on `settings`, `profiles` and `mcp_servers` (migration 017)
  goes up by one in the statement of every write that changes the row: a settings update, a new profile version or an
  enable or disable (profile versions alone could not do this, because enable and disable add none), and an MCP create,
  update or source change. A write that changes nothing leaves it. Reads return `revision`.
- **`expectedRevision`.** Settings, profile and MCP server writes and the MCP `DELETE` (query parameter, as a DELETE has
  no body) accept it. It is checked first, under the same locks, against the row that is about to be changed; any other
  revision, or no row at all, throws `AdminConflictError` inside the transaction, which rolls back, and ingest answers
  `409`. Omitted, nothing is checked (last writer wins, as before). It must be a positive integer (`400`), and ingest takes
  it out of the body before the validators that refuse unknown keys, which stay `400`.
- **Not covered.** A deleted MCP server created again under the same name restarts at revision 1, so a stale draft can
  still overwrite it. The console ships in the ingest image, so a reload after an upgrade is enough for contract changes.
- **Reads and downloads for the console.** `GET /admin/tools` returns the names profile writes are checked against (the
  orchestrator's last publication, else the built-in names). `GET /admin/skills/{name}/versions/{v}/zip` returns a version
  as a stored zip with the executable bit in the Unix mode (`packages/session-core/src/zip.ts`, about 90 lines on
  `node:zlib`'s `crc32`, no dependency).
- **Reserved `source`.** Skill versions and MCP servers accept `source: { repository, commit }` (strictly validated and
  size-limited), stored in a nullable jsonb column and returned. It is outside the skill digest and outside the MCP
  server's config, so nothing reacts to it. Publishing identical files with another `source` creates no version and keeps
  the stored one (versions are immutable). An MCP `PUT` that omits `source` keeps it, `null` clears it, and a change of
  `source` alone is a write: it adds a revision and a history entry whose `old` and `new` configs are equal.

## Consequences

- A console that sends `expectedRevision` always gets a `409` instead of a silent overwrite; plain API clients are unchanged
  except that they can no longer disable the default profile.
- The race test runs on the in-memory fake, which models advisory locks per client: it holds the lock, starts both writes,
  releases it and checks that the default is enabled for both start orders. There is no real Postgres in the unit tests.
- Migration 017 only adds columns with defaults and is idempotent; rolling back the images leaves the columns unused.
