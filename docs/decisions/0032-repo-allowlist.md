# 0032: Repo allowlist

Status: accepted, 2026-11-18 (issue #197). Amends [0008](0008-settings-in-postgres.md).

## Context

`POST /sessions { repo }` only checked that `repo` looked like `owner/name`. Nothing tied a caller to the repositories
they may use. Any holder of an API token, admin or not, could start a session on any repository the GitHub App is
installed on. The orchestrator then minted a token with `contents: write` and `pull_requests: write` for it and cloned
it. The `agent/**` branch ruleset ([repo-workspace.md](../repo-workspace.md)) limits where pushes land. It does not stop
anyone reading private code or opening pull requests.

## Decision

- **A `repoAllowlist` setting** (`inbox.settings.repo_allowlist`, `jsonb`, migration `023_repo_allowlist.sql`).
  - **Entries.** Each entry is `owner/name`, `owner/*` (every repository of that owner) or `*` (every repository the App
    can reach). At most 200, stored lowercase and deduplicated, matched case-insensitively like GitHub names.
  - **Seed and changes.** It is seeded from `PI_REPO_ALLOWLIST` (comma-separated; chart value `github.repoAllowlist`).
    Change it with `PUT /admin/settings` or the console's settings page, with a revision and history like every other
    setting.
- **Empty refuses every repo session.** That is the default, and also the value an existing deployment gets from the
  migration.
  - **Upgrade cost.** After the upgrade an admin must list the repositories before repo sessions work again. That is
    the safe direction for a missing rule.
  - **Plain sessions** never consult the list.
- **Checked when a session is created.** Ingest answers `403 { "error": "repo \"o/n\" is not on the repo allowlist" }`,
  after the `repo` and `branch` validation (`400`) and before anything is stored.
- **Checked again before every token mint.** `RepoAccess` asks the orchestrator's settings cache before it mints, on
  the first input and on each renewal (about hourly).
  - **Effect.** A repository an admin removes gets no new token. A running session loses GitHub access when its current
    token expires, within an hour. That session's inputs and tool calls then fail with the same message. The session
    is not failed, so listing the repository again lets it continue.
  - **Why not end access at once.** Pulling access immediately would mean revoking the OneCLI agent's secrets
    mid-session. The one-hour bound matches the token's own lifetime.
- **Global, not per owner.** The list says which repositories the platform may touch, not which caller may touch
  which. Every caller can use every listed repository. Per-owner grants, for an install shared by several teams, are a
  later change and would be checked at the same two points.

## Also

Install the GitHub App only on the repositories you mean to use. The allowlist narrows what the installation offers;
it cannot widen it.
