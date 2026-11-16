# 0005: Migrations take no DDL locks when the schema is current; the drain transaction stays (for now)

Status: accepted, 2026-11-16 (issue #3).

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

## The long drain transaction (assessed, not changed)

Holding a transaction across the workspace preparation is a cost, but it is also what makes `crash-before-mark`
(`tests/e2e/run-phase4.sh`) hold: the row locks mean a crash between submit and mark rolls the row back to `pending`,
and Pi Durable's idempotent `requestId` keeps the retry from double-submitting.

Shortening it means splitting `SessionService.apply` into an idempotent prepare phase (ensure conversation, budget,
`#prepareRepo`) that runs before the claim, and the claim + submit + mark that stays transactional. The submit/mark
window and its guarantee would be untouched. It is not done here because it is not small: prepare failures currently
become row outcomes (`PermanentError` fails the row, a transient error bumps `attempts` and stops the batch, a lost
workspace fails the session), so prepare outside the transaction needs its own claim-free way to record those, plus
care that two orchestrators or a drain and a delete do not prepare concurrently. With migrations no longer taking
locks, the remaining harm of the long transaction is bounded: row locks on that session's pending events only (other
sessions' rows are skipped, ingest inserts do not conflict with them).

Related risk, to be handled in that follow-up: each busy session holds one pool connection for the whole preparation.
The orchestrator inbox pool has `max 10` (`main.ts`), `MAX_PARALLEL_SESSIONS` is 8 and the LISTEN connection takes
one, so eight concurrent repo sessions leave a single connection for `getSession`, `setExecInFlight`, the watcher and
the HTTP owner check, each waiting at most `connectionTimeoutMillis` (5 s). Until then the pool should be sized as
`MAX_PARALLEL_SESSIONS + listener + headroom`, or the parallelism lowered for repo sessions.

## Consequences

- A restart of any process on a current schema issues no DDL and cannot be stalled by, or stall, running traffic.
- A new migration file is applied by the first process that starts with it, under the lock; it can still wait for
  running drains (fail fast, retry), but never queues ahead of traffic for longer than 3 s per attempt.
