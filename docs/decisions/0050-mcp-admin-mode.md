# 0050: Opt-in admin mode of the MCP adapter

Status: accepted, 2026-11-20 (issue #321). Amends [0031](0031-mcp-adapter.md), which kept the adapter off `/admin/*`.

Amended by [0070](0070-mcp-admin-parity.md) (2026-11-25): a third flag, `PI_MCP_ADMIN_DANGEROUS`, and admin tools for skills, MCP servers, egress, settings and the deployment as a whole; "two switches" and "no other admin write" no longer hold.

## Context

Changing the deployment (a profile's instructions, its rule sets) needed the admin API by hand: an agent asked to
"update the renovate profile" had to find an admin token and call `/admin/*` with curl. A typed tool with a scoped,
explicitly configured token is easier to use and easier to audit.

## Decision

- **Off by default, two switches.** `PI_MCP_ADMIN=true` adds read tools for profiles, skills, MCP servers, egress rule
  sets and settings. `PI_MCP_ADMIN_WRITES=true` (which needs the first) adds `admin_put_profile` and
  `admin_delete_profile`. No other admin write is exposed.
- **A second token.** Admin calls use `PI_API_ADMIN_TOKEN`, which must differ from `PI_API_TOKEN`; the session tools keep
  the session token. Ingest stays the authorization boundary: the token must belong to an owner in `PI_API_ADMINS`.
- **One HTTP client.** Admin calls go through `SessionApi.admin`, the same client as the session tools: https or
  loopback only, no redirects (they would resend the token), a 30 s timeout, the caller's cancellation, server errors
  cut to 300 characters. Paths are built from names checked against ingest's own rules and URL-encoded.
- **Concurrency as in the console.** Writes carry `expectedRevision` (0: create only); a stale one is ingest's `409`
  (ADR 0023). Delete follows ADR 0027.
- **Output is untrusted.** Every answer is scrubbed of both tokens and labelled as data, not instructions.

## Consequences

- A client with admin mode reads the deployment's configuration; with writes it can change or delete profiles. A
  shell-capable agent can read its own MCP config, so enable it only for clients you would give the admin token to.
- No database access and no new ingest route: the adapter is still only a client.
- Skill, MCP server, egress and settings writes, and rendering a session's instructions, are left for later.
