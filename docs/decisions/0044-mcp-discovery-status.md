# 0044: MCP discovery status in the shard status row

Status: accepted, 2026-11-19 (issue #292). Amends [0009](0009-mcp-catalog-in-postgres.md) (reachability was always
`unknown`). Related: [0007](0007-native-remote-mcp.md), [0040](0040-mcp-egress-flow.md), and the shard status row of
[0017](0017-schema-sharding.md) that carries the isolation probe (`docs/session-api.md`).

## Context

0009 left `reachability` at `unknown` and named the signal an admin has: the orchestrator's `mcp-discovery-failed` log.
It rejected a probe from ingest because it would test ingest's path, not the orchestrator's through the gateway, and
listed a probe through the orchestrator as a possible follow-up. Reading a log is not something the console can do.

## Decision

- **The orchestrator reports what it already does.** Discovery of each enabled server (connect and `tools/list` through
  the gateway, with the existing retry loop) records its latest outcome after every attempt: `ready` with the tool count
  and names, or `failed` with an error. No new probe and no new traffic.
- **Where: a column of the shard status row.** `inbox.shard_status.mcp_discovery` (jsonb, name to outcome) follows the
  isolation probe's rule: the shard's own orchestrator is the only writer, ingest only reads, and the row is reset at
  every start so a new process does not report its predecessor's observations. A separate table was not clearly cleaner:
  the outcome is a per-orchestrator observation with the same lifecycle. The migration (033) is idempotent DDL like the
  others.
- **Writes are ordered and best effort.** One write at a time, in the order the outcomes happened, so a late `ready`
  cannot overwrite the removal of a server that was replaced. A failed write is logged (`mcp-status-write-failed`) and
  dropped: status never gates discovery or serving. A retired server reports nothing after it is retired.
- **The error is sanitized before it leaves the orchestrator.** Collapsed whitespace, at most 300 characters, and
  credentials (bearer tokens, credential headers, URL userinfo, secret query parameters, long opaque strings) replaced.
  The gateway injects credentials, so an error that quoted a request must not carry them to the admin API.
- **Several shards: a failure on any shard wins.** Each shard's orchestrator discovers through its own pod and path, and
  the catalog is shared, so the API reports one view per server instead of a list: the lowest failing shard, else the
  lowest shard's `ready`, with the `shard` named. Shard 0 alone (as for the isolation probe) would hide a shard that
  cannot reach a server, which is the case an admin must see. `unknown` while no shard has reported, `disabled` for a
  disabled server, whatever an orchestrator last said.
- **API and console.** `reachability` becomes `ok`, `failing` or `unknown`, and each server gains `discovery`
  (`docs/session-api.md`). The console's list shows the status with the error and time, and Details the tool names.

## Consequences

- An admin sees a host missing from the OneCLI rules or the egress policy on the server's row, without the logs.
- The status is as fresh as the last attempt: a succeeded discovery is not repeated until a row change or a restart
  (0009), so `ok` means "worked then", and `checkedAt` says when. A server that goes down later still shows `ok`; a
  call-time health check is not part of this.
- A restart shows `unknown` until each server has been listed again, usually seconds.
- Existing fields are unchanged; a client that ignores `discovery` sees only `reachability` change from the constant.
