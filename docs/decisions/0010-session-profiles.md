# 0010: Session profiles live in Postgres, versioned and snapshotted per session

Status: accepted, 2026-11-16 (issue #41). Builds on [0008](0008-settings-in-postgres.md) (settings, admin API) and
[0009](0009-mcp-catalog-in-postgres.md) (MCP catalog); replaces 0009's "all enabled servers" per-session rule.

## Context

What a session gets (coding tools, instructions, MCP servers, model, turn budget) was global: every new conversation
had all coding tools and, since 0009, every enabled MCP server. Operators need named variants ("research": read-only
tools plus DeepWiki; "coding": today's behaviour) that the client picks on `POST /sessions`, that change without a
restart, and that never alter a session that already runs.

## Decision

- **Storage.** `inbox.profiles` (`name` primary key, `current_version`, `enabled_for_new`, created and updated at/by)
  and `inbox.profile_versions` (`name`, `version`, `definition` jsonb, created at/by; primary key `(name, version)`).
  Migration `008_profiles.sql`, idempotent. Version rows are immutable (a trigger refuses update and delete). The
  history of a profile is its versions: who and when, and the full definition of each. A change of `enabled_for_new`
  alone is not versioned (it is state, not content); only the last toggle (`updated_at/by`) is kept.
- **Definition, one validator.** `validateProfileDefinition` in `packages/session-core/src/profiles.ts` checks admin
  input and stored rows alike and returns the normalised value (fixed key order, duplicates dropped, idempotent, so a
  write is read back unchanged; the lesson of 0008 and 0009: never persist what the read path rejects). Every field is
  optional, and absent means "as without profiles":
  `tools` (enabled coding tools; absent: all), `modelTools` (offered to the model, a subset of `tools`; absent: all
  enabled), `instructions` (at most 8000 characters), `defaultModel` (`provider/model`), `reasoning`, `turnBudget` (1 to
  1000000), `mcpServers` (catalog names; absent: none).
  Shape is validated everywhere; names are checked against what exists only when an admin writes a new version
  (`checkProfileNames`): tools against `inbox.orchestrator_capabilities`, MCP servers against the catalog (enabled or
  not). A read never fails because a name stopped resolving: that would turn a removed tool into a lost profile.
- **The default profile is `coding` version 1, seeded by the migration with the empty definition**: every coding tool,
  no extra instructions, the settings' model, reasoning and turn budget. **It has no MCP.** Until 0009 a new conversation
  got every enabled server; opting in per profile is safer (a server added to the catalog reaches no session by itself,
  and a profile is a reviewable list of who may use what). Operators who want MCP everywhere put the servers in the
  default profile (`PUT /admin/profiles/coding`). `settings.defaultProfile` (column `default_profile`, also in 008; null
  or absent means `coding`) names the profile used when a request has none; the settings PUT refuses a profile that
  does not exist or is disabled.
- **Snapshot.** At creation ingest resolves the profile's current version and stores name, version and the definition
  (`inbox.sessions.profile_name`, `profile_version`, `profile_snapshot`). The orchestrator reads the snapshot from the
  session row, never the live profile, so editing, disabling or (not possible) deleting a profile changes no existing
  session, and a session stays resolvable whatever happens to the profile row. A snapshot that fails validation (edited
  by hand) is refused with a permanent error, never applied in part. A session without a snapshot predates profiles: it
  runs as `coding` v1 (empty definition: all coding tools, no MCP, the settings' turn budget) and its API reports
  `profile: { name: "coding", version: 1 }`.
- **Two separate states.** `enabled_for_new` decides whether a NEW session may choose the profile; it never affects
  sessions that exist. A missing, disabled or invalid profile fails closed: `400` when the client asked for it, `503`
  when the settings' default is the problem. It never falls back to another profile.
- **No DELETE.** A profile is disabled, not deleted: the versions are the audit trail of what sessions ran with, a
  delete would need "no active session uses it" (a race with creation) and buys nothing, since names are cheap. A
  disabled profile can be enabled again, and a new version can be written while it is disabled.
- **Ingest.** `POST /sessions` takes an optional `profile` (a name). Model and reasoning precedence, field by field:
  explicit request, then the profile's `defaultModel` and `reasoning`, then the settings. The result goes through the
  same allowlist and `maxReasoning` checks as a plain request at creation time, so a profile that no longer fits the
  settings is refused (`400`, naming the profile), not applied. The response and `GET /sessions/{id}` echo
  `profile: { name, version }`.
- **Admin API** (same admin check as the others): `GET /admin/profiles`, `GET /admin/profiles/{name}` (with every
  version), `PUT /admin/profiles/{name}` with `{ definition?, enabledForNew? }`. A changed definition writes the next
  version (`201` for the first, `200` after); an identical one writes nothing; `enabledForNew` alone only toggles.
  Writers are serialised per name by an advisory lock, and the profile and version rows go in one transaction.
- **Orchestrator.** `Host.createConversation(model, definition)` passes the snapshot to Pi Durable's agent options
  (`tools`, `modelTools`, `instructions`, `extensions`). `tools` and `modelTools` are given as `{ remove: [...] }`: an
  array would enable exactly those names and so drop `tool_search` and the MCP tools, which are found later. The
  coding tools the profile does not list are removed. A profile with `mcpServers` adds `tool_search` and one
  `mcp-<name>` extension per server, through `extensions: { add }`: the host default stays pinned to `coding`, so no
  extension reaches a session that did not select it. Both creation paths (the inbox and the stream) go through
  `SessionService.ensureConversation`, so both use the snapshot. The turn budget is `snapshot.turnBudget` when set, else
  the settings' value (read per input as before); it replaces the global one for that session.
- **Names against reality.** At its start the orchestrator publishes its installed coding tool and extension names to
  `inbox.orchestrator_capabilities` (one row) and logs `profile-unresolved` for any stored profile whose tools no longer
  resolve (a warning: such a session has fewer tools, never more). Ingest checks admin writes against that row; before
  any orchestrator has started it uses `BUILTIN_TOOL_NAMES` in session-core (the four coding tools; a test keeps it
  equal to what the host installs) and logs `capabilities-missing`.
- **A server missing or disabled at session creation is not fatal.** The name is stored anyway (an empty stand-in
  extension by name) and `tool_search` is added, so the tools are `tool_unavailable` until the server is enabled, as in
  0009 for a server removed later. Whether the server is enabled is the catalog's concern, not the profile's.

## Not done

- Per-principal allowlists for privileged profiles (the issue says "if some profiles are privileged"): none is
  privileged yet, and the owner model has only admins and others. A column on `profiles` can add it without changing
  the snapshot design.
- A history row for `enabled_for_new` toggles.
- Refusing a `defaultModel` for a model without reasoning (same limit as 0008).

## Consequences

- Adding an MCP server no longer gives it to anyone: a profile must name it. Deployments that relied on 0009's
  "every enabled server" must add the servers to a profile (the e2e suite does).
- Existing sessions keep their conversations (the agent is stored by Pi Durable at creation) and their behaviour; the
  migration needs no backfill.
- Ingest reads one profile row (a join of two tables) per `POST /sessions`; there is no profile cache because the
  read is cheap and a stale one would defeat "disable" taking effect at once.
