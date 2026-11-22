# 0058: Each input's outcome on its inbox row; an owner-scoped event feed with a commit-safe cursor

Status: accepted, 2026-11-22. Implementation: issue #364 (outcome, `GET /sessions/{id}/events/{eventId}`) and issue #365
(feed). Prepares for MCP Tasks ([0031](0031-mcp-adapter.md)) and MCP Events ([0059](0059-remote-mcp-endpoint.md),
[0060](0060-mcp-event-triggers.md)). Builds on [0029](0029-run-outcomes-from-wait.md) and [0017](0017-schema-sharding.md).

## Context

A client learns what happened to a session only from that session: `GET /sessions/{id}` and its stream. Two things are
missing.

- **Per-input outcome.** `Submission.wait()` tells the orchestrator how each input settled (0029), but nothing stores
  it. `wait` in the MCP adapter therefore decides "done" for the session as a whole, and MCP tasks mode waits for "a
  per-event outcome on the inbox row and `GET /sessions/{id}/events/{eventId}`" (0031).
- **Change notification across sessions.** A client that stopped watching a session (or lost its id) does not learn
  that it failed, and an MCP Events source needs one resumable feed per caller. A feed whose cursor is a sequence id
  loses rows: ids are taken at insert, transactions commit in another order, and a reader that has read id 11 never
  sees id 10 committed after it.

## Decision

### 1. The outcome of each input (#364)

- Migration 035 adds `outcome` (`answered` or `unanswered`), `outcome_reason` and `settled_at` to `inbox.events`.
- The orchestrator's run watcher writes them when a submission settles, before usage and failure handling:
  `answered`, or `unanswered` with Pi Durable's reason (`model_error`, `aborted`, `run_failed` for an input withdrawn
  behind a failed run, `turn_limit`, ...; at most 64 characters). **Never the provider's error text**: the detail can
  carry a provider's message or a key fragment, and the session's `failure` already follows that rule.
- Written once (`where outcome is null`), so a watch recovered after a restart changes nothing. Only `message` and
  `steer` rows take one.
- `GET /sessions/{id}/events/{eventId}` returns `{ eventId, kind, status, createdAt, submittedAt?, outcome? }`, owner
  checked like every session route, answered from Postgres. The row's stored `error` is not returned: it is the
  orchestrator's own message and can name internals. An id that is not an event of this session is `404`.
- Not covered: inputs settled before migration 035 (no outcome), and an input Pi Durable never admitted (its row is
  `failed`, no outcome).

### 2. The owner feed (#365)

**Outbox table, written by triggers.** `inbox.feed (id bigint identity, xid xid8 default pg_current_xact_id(),
owner_subject, session_id, type, data jsonb, created_at)`. Triggers on `inbox.sessions` (insert, status change) and
`inbox.events` (`failed`, outcome set) insert the rows in the transaction that made the change. Ingest and the
orchestrator both write those tables; a trigger cannot be forgotten by a new writer. Sessions without `owner_subject`
(from before it existed) write nothing.

| `type` | `data` | When |
|---|---|---|
| `session.created` | `{ profile }` | Session row inserted |
| `session.status` | `{ status, failure? }` | `failed`, `deleting`, `deleted`; `failure` is the stored, fixed message |
| `input.settled` | `{ eventId, kind, status, outcome?, reason? }` | A row ends `failed`, or its outcome is set |
| `park.opened`, `park.closed` | reserved for [0054](0054-signals-parking-and-approval-gates.md) | |

Payloads are minimal hints; the client reads the current state with the existing routes.

**Commit-safe cursor: snapshot xmin.** A reader returns only rows whose `xid` is below
`pg_snapshot_xmin(pg_current_snapshot())`: every transaction below it has ended, so every such row that will ever exist
is visible now. Rows are ordered by `(xid, id)` and the cursor is that pair. Any row not yet returned belongs to a
transaction at or above the current xmin, so it sorts after the cursor: **no row is skipped**, whatever the commit order.
The order is transaction order, not wall-clock order; payloads are hints, so a client that needs the latest state reads
it.

- Cost: an open transaction anywhere in the cluster holds the watermark back and delays the feed (never loses rows).
  Inbox transactions are short since [0005](0005-migrations-without-ddl-locks.md); a long one shows as feed lag, which
  shard 0 of the orchestrator logs (`feed-lag`) when the oldest open transaction is older than 60 s.
- Rejected: **serialised inserts** (a global advisory lock taken by the trigger and held to commit). It orders ids by
  commit, but every session create, status change and outcome write in the database waits on one lock, and a trigger
  that takes it after a row lock can deadlock with a writer that holds it and wants the row. **A sequence-id cursor**
  loses rows (above). **`LISTEN/NOTIFY` alone** is not durable.

**API.**

- `GET /events?cursor=&limit=` returns `{ events: [{ id, type, sessionId, timestamp, data }], cursor, hasMore,
  truncated }` for the caller's subject only. No `cursor` starts at the oldest retained row; `cursor=latest` returns no
  events and the current head (MCP's `cursor: null`). `limit` 1 to 500, default 100. A malformed cursor is `400`.
- `GET /events/stream` is server-sent events of the same rows, resuming from `Last-Event-ID` (the cursor), with a
  `heartbeat` event (a data frame, as MCP Events push expects) every 15 s. Ingest polls the table for the connection
  about every second; a `NOTIFY` wake-up can come later. At most 100 open feed streams per ingest replica (`503` with
  `Retry-After` beyond), so the polls stay bounded.
- Answered by ingest from Postgres, so it works while the orchestrator is down.

**Retention maps to `truncated`.** Rows older than 7 days (`PI_FEED_RETENTION_HOURS`) are deleted by shard 0 of the
orchestrator (periodic work is per shard, 0017), which records the newest deleted position in `inbox.feed_horizon`. A
cursor below the horizon gets `truncated: true` and continues from the horizon: the client knows it missed rows and
re-reads the sessions it cares about.

**A feed is not a list.** `GET /sessions` (the adapter's "lost sessionId" gap) is a separate route with its own issue;
the feed is not filtered by session and keeps no current state.

## Consequences

- MCP tasks mode has its prerequisite. `taskId = <sessionId>.<eventId>` and `tasks/get` reads the event route (0031).
- One MCP Events occurrence is one feed row: `eventId` = row id, `name` = `type`, `timestamp`, `data`, `cursor`.
- Every session change writes one more row in the same transaction. Volume is a few rows per input.
- Tests: the outcome write and its idempotence, the event route's owner check and fields, and for the feed a test against
  a real Postgres in which a transaction that took its id first commits last, and the reader still returns its row.
