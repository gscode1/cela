# 0005: Migrations take no DDL locks when the schema is current; repo preparation runs outside the drain transaction

Status: accepted, 2026-11-16 (issue #3). The drain-transaction section was superseded the same day by issue #62; the original assessment is kept below as history.

## Context

On 2026-11-16 ingest pods crash-looped while repo sessions were starting:

1. The orchestrator's inbox drain (`InboxLoop.#drain`) opens a transaction, locks the claimed `inbox.events` rows
   (`FOR UPDATE SKIP LOCKED`) and keeps it open while `#apply` creates the sandbox, provisions OneCLI and clones the
   repository (about 96 s observed). Only then does it mark the row and commit.
2. `applyMigrations` re-ran every migration (DDL) in a transaction at every process start. `ALTER TABLE` needs ACCESS
   EXCLUSIVE, so it queued behind the drain, hit `statement_timeout`, and while queued it also blocked every other
   query on those tables, including ingest's inserts.
3. Ingest ran migrations before it listened, so `/healthz` was not served, the liveness probe failed six times and the
   kubelet killed the pod (exit 137), which restarted into the same wait.

## Decision

- `inbox.schema_migrations(version, applied_at)` records each applied file. A start reads it with a plain SELECT;
  when every file is recorded it returns without a lock or any DDL. Only a missing file takes the advisory lock, under
  `lock_timeout = 3s`, and runs just the missing files (still idempotent). The caller retries on failure.
- Rollout: a database that predates the table has everything applied but nothing recorded. Its first start takes the
  slow path once: the idempotent files re-run (no change) and are recorded. That one run still needs the DDL locks,
  so it can fail fast behind a long drain and retry until the orchestrator is between rows; afterwards no start does
  DDL again. Old ingest/orchestrator images keep running their old unconditional DDL until they are replaced.
- Ingest listens first and migrates in the background. `/healthz` (liveness) answers from process start; `/readyz`
  and the API answer `503` until migrations succeeded, then keep their meaning ("the database answers"). The
  orchestrator already listened before migrating, so its code is unchanged. It gets the same liveness probe on
  `/healthz` (period 10 s, timeout 3 s, six failures), which answers without touching Postgres.

## Repo preparation runs outside the drain transaction (issue #62)

The drain used to hold its transaction (and one pool connection) across `SessionService.apply`, so across the OneCLI
provisioning and the clone: 96 s observed, eight sessions nearly exhausting the pool of 10, and a hung OneCLI holding
row locks for ever. Now each drain step has two phases:

1. **Prepare** (`InboxLoop.#prepareHead` -> `SessionService.prepare`): no transaction, no checked-out client, only
   `pool.query`. It reads the session's pending rows without locking and prepares for the first `message`/`steer`
   that comes before any `delete`: ensure the conversation, then for a repo session the GitHub token, the OneCLI agent
   and secrets, the grant check and the clone. Prepare is per session, so one run covers the whole batch.
2. **Claim** (unchanged shape, now short): `begin`, `FOR UPDATE SKIP LOCKED`, per row `apply` (budget, submit to Pi
   Durable, mark `submitted`), `commit`. `apply` no longer prepares the repo.

What keeps `crash-before-mark` (`tests/e2e/run-phase4.sh`) true: the submit and the mark are still in one
transaction with the row locks, so a crash between them rolls the row back to `pending` and Pi Durable's idempotent
`requestId` absorbs the second submit. Prepare writes nothing the claim depends on and is idempotent, so a crash at
any point of it leaves the rows `pending` and the retry runs it again: the agent and secrets are found by their
names and reused (the GitHub token is re-minted and the secret value rotated), `/workspace/repo/.git` present skips
the clone, `markWorkspaceReady` is an upsert of one column.

Outcomes are as before, recorded by the same code (`#recordFailure`) on the pool instead of the claim's client:
`PermanentError` (refused access, lost workspace, repo not configured) ends the row `failed` (the lost-workspace and
refused-access cases fail the session too); anything else bumps `attempts`, leaves the row `pending` with the error,
and stops that session's batch so later rows cannot overtake it (the claim still applies rows that precede the failed
input, such as a `cancel`). The fifth failed attempt ends the row.

Not guarded: two orchestrators preparing the same session at once. The orchestrator is a single replica holding a
storage lock (`lock-acquired`), a session is drained by one loop at a time, and a `delete` is a row of the same
session's queue, so it never runs in parallel with that session's prepare. If that ever changes, prepare is still
safe to run twice (above); the cost would be extra OneCLI calls, and two clones racing on `/workspace/.clone-tmp`
would fail one of them into the normal retry.

Rejected: recording intent in a first transaction (a status such as `preparing`) and committing before prepare. It
needs a new row state, a way to recover rows stuck in it after a crash, and a schema change, to protect against
something the idempotent prepare already makes harmless.

### OneCLI admin calls

Each attempt has an `AbortSignal.timeout` (default 15 s, `PI_ONECLI_TIMEOUT_SECONDS`). A network error, a timeout or a
5xx is retried up to `PI_ONECLI_RETRIES` times (default 3) with doubling backoff from `PI_ONECLI_BACKOFF_MS` (default
500 ms, capped at 5 s); a 4xx never is. A `POST` (create agent, create secret) is never re-sent by the
retry, because a lost answer may hide an applied create. Each create is find-or-create instead: after an ambiguous
failure (5xx, timeout, network) and the backoff, the next round looks the object up by name and creates it only if
it is still absent, so it is never created twice. The worst case for one call is about 4 x 15 s + 6.5 s of backoff, with no transaction held.

### The pool

The prepare phase uses a pool connection only for single statements, so a busy session no longer pins one.

Correction (issue #208): the pool of 10 was too small. Three clients stay in LISTEN for good (the inbox's
`inbox_events`, `SettingsCache` and `McpCatalogCache`), not one, which left 7 for up to `MAX_PARALLEL_SESSIONS` (8)
claims. Code inside a claim also needs a second connection (`#delete`'s tombstone and status writes, `#failSession`,
`ensureConversation`), so with 7 or more sessions draining at once the claims held every free connection and their
nested queries timed out after `connectionTimeoutMillis`. The pool is now sized from its users, `INBOX_POOL_SIZE` in
`inbox.ts`: 3 listeners + 2 x 8 drains + 5 headroom (streams, run watchers, exec-in-flight records, HTTP routes, the
sweep) = 24 per shard. `test/inbox-pool.test.ts` checks the listener count against `main.ts` and the arithmetic. With the
default `max_connections` of 100 this fits a few shards next to the Pi Durable connections and ingest; a deployment with
more shards raises `max_connections` with them.

## Earlier assessment (kept for history)

Before #62 the transaction was left alone: it is also what makes `crash-before-mark` hold, and shortening it means
splitting `SessionService.apply` into an idempotent prepare phase and the transactional claim + submit + mark. Prepare
failures then needed their own claim-free way to record row outcomes. That is what #62 did.

## Addendum: one orchestrator per shard (issue #84)

"The orchestrator is a single replica holding a storage lock" is per schema since [0017](0017-schema-sharding.md): each
shard is its own Deployment on its own schema, and a session is drained only by its shard's loop (the inbox poll filters
on `s.shard`). The argument that one session is never prepared twice still holds. Migration `014_shard.sql` adds the
`shard` column; shards above 0 create their schema at start before migrating. The inbox poll also leaves sessions that
are in flight or backing off out of its query and serves the oldest pending event first (`InboxLoop.#tick`, #95).

## Consequences

- A restart of any process on a current schema issues no DDL and cannot be stalled by, or stall, running traffic.
- A new migration file is applied by the first process that starts with it, under the lock; it can still wait for
  running drains (fail fast, retry), but never queues ahead of traffic for longer than 3 s per attempt. Since #62 a
  drain holds row locks only for the short claim, so that wait is short too.
