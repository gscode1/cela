# 0009: The MCP server catalog lives in Postgres, changed through the admin API

Status: accepted, 2026-11-16 (issue #40). Amends [0007](0007-native-remote-mcp.md): the static `PI_MCP_SERVERS` is gone.
Per-session selection is [0010](0010-session-profiles.md) (#41), credentials are #42.

## Context

0007 read the server list once from `PI_MCP_SERVERS`: adding a server meant editing the Deployment and restarting the
orchestrator, and nothing recorded who changed what. 0008 already moved model settings into Postgres with an admin API,
a history table and `LISTEN/NOTIFY`; the MCP catalog needs the same properties.

## Decision

- **Storage.** `inbox.mcp_servers` (migration `007_mcp_servers.sql`, idempotent): `name` (primary key, the
  `mcp__<name>__` prefix, immutable), `url` (https, no credentials), `transport` (`streamable-http` only, a check),
  `enabled`, `read_only` (the operator's declaration that the server is stateless and read-only; required on create),
  `timeout_ms` (1 s to 5 min, default 60 s), `max_output_bytes` (1 KiB to 24 KiB, default 24 KiB: `limitMcpContent`
  already cuts text at 20 KB, so a row can only tighten), `onecli_secret` (a nullable reference, unused until #42; never
  a secret) and created/updated at/by. The table checks repeat only the cheap shape rules.
- **History: a separate `mcp_servers_history`, not `settings_history`.** `settings_history` is `old`/`new` of one
  singleton with `new not null`; the catalog has many rows and a delete has no new value, so it needs a `name`, an
  `action` (`create`, `update`, `delete`) and a nullable `new`. Squeezing that into the settings table would change its
  shape for the sake of sharing a name. Append-only, like the other.
- **One validator.** `validateMcpServer` in `packages/session-core/src/mcp-servers.ts` checks admin input and stored
  rows alike (the lesson of the 0008 review: never persist a row the read path rejects). A PUT validates the merged
  object, so what is written is by construction what is read back; `readMcpServers` still validates each row, skips one
  that was edited by hand into something invalid and reports it (`invalid` in the API, `mcp-server-invalid` in the log),
  so one bad row never takes the others down. The name `history` is reserved for the history route.
- **Admin API** (ingest, same admin check as `/admin/settings`): `GET /admin/mcp-servers`, `GET/PUT/DELETE
  /admin/mcp-servers/{name}`, `GET /admin/mcp-servers/history`. PUT creates (`201`) or updates (`200`, partial: omitted
  fields keep their value); a no-op PUT writes nothing. DELETE removes the row for real (refused while a profile's
  current version names it, and the name is never created again, [0027](0027-admin-delete.md)); "disable" is `PUT {"enabled":
  false}`, which keeps the row and its settings. Every write is one transaction: row, history entry and
  `pg_notify('pi_mcp_servers', name)`, so a rolled-back write notifies nobody.
- **Reload.** `McpCatalogCache` (session-core) is `SettingsCache`'s sibling: loads at start, refreshes on the
  notification and on a 30 s poll, keeps the last good catalog when a read fails. The orchestrator subscribes and calls
  `McpTools.apply`, which makes the installed extensions match the enabled rows:
  - added or enabled: install `mcp-<name>` (empty), list the tools in the background (0007's discovery);
  - removed or disabled: `registry.uninstall`, so a new call settles `tool_unavailable`. Calls that already started
    finish; the client is closed after the last one. A call that starts afterwards from a stale handle fails at once;
  - row changed (any field): a new server object with a new client replaces the old one by name (no gap in the registry)
    and re-lists the tools; the old one is retired as above. A tool whose input schema differs from the version it
    replaces is logged `mcp-schema-changed`;
  - unchanged: nothing happens (same client, no reconnect).
  Shutdown does not wait for running calls.
- **No seeding, no `PI_MCP_SERVERS`.** The variable was empty by default and only the e2e set it, and the orchestrator
  owns no migrations or seeding, so it is dropped rather than imported. The e2e suite `PUT`s DeepWiki through the admin
  API and `DELETE`s it at the end.
- **Empty catalog: the pin stays, `tool_search` is not added.** The host default is now always pinned to `coding`
  (0007 pinned it only "with the flag on"), because the catalog is a runtime state: if the pin followed it, a restart
  while the catalog was empty would unpin, and every existing conversation would select all installed extensions
  (`tool_search`, and each `mcp-*` once servers exist) at the next restart that found a server. Always pinned means an
  existing conversation never gains MCP silently, whatever the catalog does. A new conversation adds `tool_search` and
  the `mcp-*` extensions of its profile's servers only (0010), so a session whose profile has no MCP servers is offered
  exactly the coding tools, whatever the catalog holds.
- **Which conversations get which servers.** Superseded by [0010](0010-session-profiles.md): a conversation gets
  `tool_search` and the servers its session's profile names (`mcpServers`), not every enabled server, and the default
  profile names none. The rest still holds: the names are stored with the conversation, a server added later reaches
  a conversation that already named it (the stored name selects the new installation), and a server removed or disabled
  leaves a stored name that selects nothing, so its tools settle `tool_unavailable`; enabling it again makes the same
  name select the new installation.
- **Enforcement stays outside the database.** A row never opens egress. The host must also be allowed in the OneCLI host
  rules and the orchestrator's egress policy (`docs/onecli-host-rules.md`); otherwise the server fails to connect and its
  tools stay `tool_unavailable`. The issue asked the admin API to report `unreachable`; this PR adds no network probing
  (a probe from ingest would test ingest's path, not the orchestrator's through the gateway), so the API reports
  reachability as `unknown` and the signal is the orchestrator's `mcp-discovery-failed` log. A probe through the
  orchestrator is a possible follow-up.
- **The gateway token is checked at use, not at start.** Without `ONECLI_AGENT_TOKEN` the orchestrator starts and an
  MCP call fails (`tool_unavailable` until discovery works), because the catalog can gain a server at any time.

## Consequences

- Adding, disabling or removing a server needs no restart and has an author and a timestamp.
- An existing conversation's tools do not change when the catalog does, except that a disabled or removed server's tools
  stop working in conversations that had them.
- A server whose tools change without a row change is noticed at the next row change or restart, not on a timer.
- `read_only` and `onecli_secret` are stored but do not change behaviour yet: `read_only` is the operator's attestation
  for profiles (0010) to select on, `onecli_secret` is for #42.
- Rejected: reusing `settings_history` (shape); seeding the table from `PI_MCP_SERVERS` (the orchestrator does not own
  seeding, and the variable was never set outside the e2e); probing reachability in the admin API (tests the wrong path).
