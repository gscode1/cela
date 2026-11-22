# 0060: MCP event triggers: catalog servers' events start or wake sessions

Status: proposed, 2026-11-22 (issue #366). Nothing is built. Builds on [0007](0007-native-remote-mcp.md),
[0009](0009-mcp-catalog-in-postgres.md), [0010](0010-session-profiles.md), [0017](0017-schema-sharding.md),
[0028](0028-token-budget.md), [0040](0040-mcp-egress-flow.md), [0054](0054-signals-parking-and-approval-gates.md) and
[0058](0058-input-outcome-and-owner-feed.md).

## Context

MCP Events let a catalog server (a code host, an error tracker, an incident tool) publish typed events with a resumable
cursor and at-least-once delivery. A trigger binds one event source to a profile: when it fires, cela starts a session,
or wakes a parked one, with no person present. The inbox already deduplicates on `(source, source_event_id)`, so an
at-least-once feed becomes one submission per event.

Triggers start unattended agents from input that outsiders can cause: anyone who can open an issue upstream can make an
event. That shapes most of this decision.

Support on 2026-11-22: the orchestrator's MCP client (`@earendil-works/pi-mcp` 1.6.0) has no `events/*`; the
TypeScript SDK's is a draft (typescript-sdk PR #3209); no server in the catalog is known to emit Events.

## Decision

### 1. Configuration and runtime state are split

- **Trigger config** is ingest-owned, revisioned, with history and the admin API, like the catalog and profiles:
  `inbox.event_triggers (name, server, event, arguments, filters, profile, repo?, run_as, prompt_template, max_live,
  rate_per_hour, max_age_ms, allow_no_replay, enabled, revision)`.
- **Runtime state** is orchestrator-owned: `inbox.trigger_cursors (name, args_digest, cursor, last_poll_at, held_since,
  gaps, last_error)`. This is an **explicit exception** to one writer per table group: the orchestrator writes the
  cursor table only, ingest never writes it, and a test enforces both directions.

### 2. Security

- **Admin-fixed prompt.** The prompt is the trigger's `prompt_template`, written by an admin. The event payload is never
  the prompt: it is inserted as a fenced data block, labelled untrusted, at a fixed place, and cut to 8 KiB. The model is
  told it is data, as with tool output.
- **A restricted profile class.** A trigger may name only a profile marked `triggerable`, and a triggerable profile is
  validated to be narrow: network mode `proxied` (never `direct`, [0038](0038-network-modes.md)), no admin-capable tool,
  no `open-web` rule set, a token budget (0028), and repository access only to branches the agent may push
  ([0027](0027-no-agent-branch-ruleset.md)).
- **Filters before anything runs.** `arguments` go to the server (for example a repository); `filters` are equality and
  membership checks on payload fields that ingest applies before it creates anything (for example
  `author_association in [OWNER, MEMBER]`). An event that fails a filter is acknowledged and dropped, counted.
- **Whose authority.** A triggered session runs as the trigger's `run_as` owner, a dedicated non-admin owner
  (`trigger:<name>`), never as the admin who wrote the trigger. Its credentials are the profile's. The upstream identity
  of whoever caused the event grants nothing (confused deputy): the trigger record states the authority, and the console
  shows it.

### 3. The poller

- **Where.** Shard 0 of the orchestrator, one pass per trigger under an advisory lock (as the host-rule reconciler,
  0040). It owns the MCP clients and OneCLI identities. A trigger's calls use its own agent `<prefix>t-<trigger>`,
  granted only that server's secret (as the discovery agent `<prefix>d-<server>`); names stay within OneCLI's 50
  characters, so a trigger name has at most 32.
- **Poll mode only** in the first slice: stateless upstream, cursor in Postgres, survives restarts, one ordinary request
  through the gateway. Push and webhook later, if latency matters.
- **Through ingest's API, so ingest stays the only session writer.** The poller calls `POST /internal/triggers/{name}/fire
  { sourceEventId, payload }` as a narrow service principal that may call nothing else. It sends the trigger name and
  the event only; ingest resolves owner, profile, repo and prompt from the trigger record, applies the filters, and
  creates the session **and** its first input in one transaction, idempotent on `(source = trigger:<name>:<argsDigest>,
  sourceEventId = eventId)`. Answers: `201` created, `200` duplicate or filtered, `429` cap reached.
- **Caps are atomic in ingest.** `max_live` (live sessions of the trigger) and `rate_per_hour` are checked and taken in
  the create's transaction, the same per-owner quota mechanism the remote endpoint needs
  ([0059](0059-remote-mcp-endpoint.md)).
- **The cursor advances only after the whole batch is acknowledged** (`201` or `200`). A `429` holds the cursor where it
  is and the poller tries later; `maxEvents` is sized to the remaining capacity, so a capped trigger does not fetch what
  it cannot take. **Ingest down**: the poller backs off and holds the cursor; nothing is lost while the upstream still
  replays it.

### 4. Failure semantics

- **Gaps.** `truncated: true` records a gap (count, time, last good cursor), logs `trigger-gap`, exports a metric and
  shows in the console. No automatic reconcile run: an admin decides.
- **No-replay types** (`cursor: null` in a poll result) are refused at create, unless `allow_no_replay` is set, which the
  console flags: such a trigger loses every event that arrives while the poller is down.
- **Replay storms.** The first poll, and every poll after a reset, sends `maxAgeMs` (default 1 hour), so a new or reset
  trigger does not replay an upstream's whole history.
- **Dedup is per subscription.** Changing `arguments` makes a new subscription: the cursor resets (with `maxAgeMs`) and the
  dedup namespace changes with `args_digest`. An event both subscriptions see may then start a second session; the
  console warns when arguments change.
- **Authorization** is the upstream's: it checks at subscribe and at delivery. A revoked secret fails the poll; the
  trigger shows `last_error` and holds its cursor.

### 5. Waiting for an event inside a session

A tool `wait_for_event(server, event, arguments)` parks the call (0054) until a matching event arrives, delivered as a
`signal` inbox event. Only servers and events the profile allows; calls use the session's own MCP agent (`<prefix><uuid>-m`,
0040), never the trigger agent; at most 3 open waits per session; a timeout of at most 24 hours (the park's expiry); the
subscription is dropped when the park closes, is cancelled, or the session is deleted.

## Build gate

Build when the orchestrator has an Events client (pi-mcp support, or the TypeScript SDK once PR #3209 is released) and one
catalog server emits Events. A fake Events MCP server is added to the orchestrator's test kit with the poller, not
before.

## Consequences

- Event-driven sessions with no per-vendor webhook code, and no inbound route into the cluster.
- New surface: one service principal and one internal route on ingest, one table each for config and cursors, one OneCLI
  agent per trigger.
- Triggered work is bounded by the profile class, the caps and the token budget; its authority is a dedicated owner.
