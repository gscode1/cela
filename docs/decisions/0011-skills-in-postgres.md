# 0011: Skills live in Postgres, pinned by profiles and written into the sandbox

Status: accepted, 2026-11-16 (issue #52). Builds on [0010](0010-session-profiles.md) (profiles, snapshots) and
[0009](0009-mcp-catalog-in-postgres.md) (admin API patterns).

## Context

Operators want to give some sessions Agent-Skills-style skills: a `SKILL.md` plus scripts and resources that the model
loads when a task matches. The Pi coding agent does this natively, but its discovery reads the host filesystem of the
agent process, which here is the orchestrator, not the session's sandbox. Pi Durable 1.5.2 has no skills subsystem
(nothing in `@earendil-works/pi-durable` loads or lists skills), but it does have prompt sections and
`conversation.configure({instructions})`. We choose per-conversation `instructions` for the catalog (it is stored with
the conversation and so survives restarts unchanged) and the sandbox env for the files.

## Decision

- **Storage.** `inbox.skills` (`name` primary key, `current_version`, created and updated at/by),
  `inbox.skill_versions` (`name`, `version`, `description`, `disable_model_invocation`, `digest`, `size_bytes`, `manifest` jsonb, created at/by) and
  `inbox.skill_version_files` (`name`, `version`, `path`, `content` bytea). Migrations `010_skills.sql` and `011_skill_model_invocation.sql`, idempotent.
  Triggers refuse update and delete on the two version tables, so a version that a profile or session refers to never
  changes or goes away; there is no delete at all. The versions are the history (who, when, what), as for profiles.
- **Digest.** SHA-256 of a canonical JSON of name, description and the files sorted by path (path, content hash,
  executable bit). Name and description are in it because the model sees them. Publishing content with the current
  version's digest writes nothing (`200`, `versionCreated: false`); anything else is the next number, under an advisory
  lock per name, in one transaction with its files.
- **One validator.** `validateSkillContent` in `packages/session-core/src/skills.ts` checks admin input; stored
  bundles are re-verified (`verifySkillBundle`: manifest equals files, sizes and hashes, digest recomputes) before use.
  Input is `{ files: [{ path, content | contentBase64, executable? }] }` (see Frontmatter below), so only regular files can be
  expressed: no symlink, device or mode exists to be refused, and any other field is. Refused: traversal, absolute and
  hidden paths, backslashes, duplicates (also by case) and a file that is also a directory, NUL and unpaired surrogates
  in text (Postgres would reject them anyway), control characters in the description, non-canonical base64, and the
  limits of the issue (name 64, description 1024 characters, `SKILL.md` 32 KiB and UTF-8, 128 files, 5 MiB, 20 skills and a 32 KiB
  catalog per profile). The profile validator additionally requires `read` among `tools` and `modelTools` when skills
  are named.
- **Frontmatter (owner decision, 2026-11-16, before merge).** Publish derives the skill's `description` (required,
  non-empty, at most 1024 characters, as in the Agent Skills format) and optional `name` from the YAML frontmatter of
  `SKILL.md`, and the separate `description` input is gone, so one skill folder works identically in a repo (#71) and in
  the admin store. A frontmatter `name` that differs from the `{name}` of the path is `400`; absent, the path's is used.
  Malformed frontmatter is `400`. `disable-model-invocation: true` keeps the version out of the catalog (stored as
  `disable_model_invocation`; it can still be pinned and is still materialized). Pi parses full YAML; we do not add a
  dependency for that: `packages/session-core/src/frontmatter.ts` is a bounded reader of flat `key: value` lines with
  plain and quoted scalars, and refuses nesting, lists, block scalars, anchors, tags and repeated keys. The cost is that
  some valid Agent Skills files (a `metadata:` map, a `description: >` block) cannot be published until they are
  flattened; the error says which line. Size limits stay in bytes (`SKILL.md`, whole skill, catalog); the description
  limit is in characters, as the format says, and the catalog byte limit bounds what that can cost. The digest still
  covers name, description and every file byte, so it covers what the model sees.
- **Profiles pin content.** A definition takes `skills: [{ name, version }]`. The admin write resolves each pair in the
  same transaction, refuses one that does not exist or whose given digest differs, and stores the `digest` with it. The
  snapshot of a session is the definition, so it carries `name`, `version` and `digest`; `GET /sessions/{id}` shows
  them. A skill update changes no profile and no session; adopting it is a new profile version.
- **Admin API** (same admin check): `GET /admin/skills`, `GET /admin/skills/{name}`, `POST /admin/skills/{name}/versions`
  (`201` or `200` no-op), `GET /admin/skills/{name}/versions/{v}` (`?content=true` adds the bytes for review). No `PUT`
  or `DELETE` (`405`). The body limit of the one route is raised to fit 5 MiB of base64.
- **Prompt.** `SessionService` builds the catalog when it creates the conversation, from the pinned versions (metadata
  only, digest checked against the pin) and `Host.createConversation` appends it to the profile's `instructions`. It
  uses the wording and `<available_skills>` shape of Pi 1.5.2's `formatSkillsForPrompt` (read tool, resolve relative
  paths against the skill's directory) and lists `<name>`, `<description>` and `<location>` (the absolute sandbox path
  `/workspace/.skills/<name>/<digest>/SKILL.md`), XML-escaped as Pi does. `buildSkillCatalog` takes explicit
  locations, so repo skills can use it. Skills that disable model invocation are not listed. Pi stores the instructions
  with the conversation, which is what makes the catalog survive restarts unchanged; a catalog snapshot column was not
  needed. Missing, changed or unconfigured skills fail the input permanently (`PermanentError`): no conversation exists
  that promises files the sandbox will not have.
- **Sandbox.** A `prepareEnv` hook of `Sandboxes` runs inside the single-flight env open, after the bridge connects and
  before the env is returned, so the SandboxClaim stays lazy (a chat-only session opens nothing) and concurrent first
  tool calls wait for a complete bundle. The orchestrator reads the session's pinned versions from Postgres, verifies
  them and `materializeSkills` writes each missing bundle: files into `/workspace/.skills/.staging/<name>-<digest>`,
  `chmod 755` for executable ones, then a rename to `<name>/<digest>`. A final directory therefore exists only complete
  and an existing one is skipped (the digest in the path is its content); staging is cleared at each attach, which
  repairs a crash. The hook runs again on every env open (first call, after suspend, recycle, eviction or restart). If it
  throws, the env is closed, the open is not cached and the call fails; the next call tries again.
- **Dedicated orchestrator module, no cache.** `packages/orchestrator/src/skills.ts` is the only code that reads
  bundles. There is no `LISTEN` cache like 0008/0009: versions are immutable and read by exact pin at creation and at
  attach, so nothing can go stale, and the orchestrator does not need to react to a publish.

## Not done

- Importing from git or an image (the issue: later; sources resolve into immutable content first).
- A `load_skill({name})` tool for profiles without `read`, and a read-only mount instead of the writable workspace.
  Until then a skill directory that already exists is not re-verified on disk, because the PVC is writable by the agent.
- Repo skills (#71), which will reuse the frontmatter parser and the catalog builder.
- A per-principal rule for who may publish beyond "admin", and a UI.
- Garbage collection of old digests on the PVC (the PVC goes with the session).

## Consequences

- Skills add one query to every sandbox env open (the session's snapshot) and, for sessions with skills, one read of
  their files.
- The workspace holds `/workspace/.skills/`; a repo session's clone is unaffected.
- A description is prompt input from an operator: reviewing it is part of publishing.
