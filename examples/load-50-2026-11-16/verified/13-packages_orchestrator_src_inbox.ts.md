### 1. Pending sessions can starve behind backed-off deletes
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/inbox.ts:110-111
- Duplicate of: none
- Reasoning: The query `select distinct session_id ... where status='pending' limit 100` has no ORDER BY and is unaware of `#notBefore` or `#inFlight`; the loop then skips those sessions in memory. Starvation needs more than 100 distinct sessions that stay pending at once (failing deletes with up to 60 s backoff, or in-flight ones) so the same hash-ordered 100 fill every poll. At the PoC scale (50 sessions) that is not reachable; it becomes real only with >100 stuck sessions.

### 2. A delete can be marked failed after partially completing
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:305-309 with inbox.ts:198-211
- Duplicate of: none
- Reasoning: `#delete` sets `status='deleted'` on a pool connection (autocommit) before `completeTombstone`. If completeTombstone throws (DB error) or the process dies, the event stays `pending`; on retry `apply` starts with `if (session.status === "deleted") throw new PermanentError("session is deleted")`, so the row ends `failed` and `inbox.tombstones.completed_at` stays NULL forever. Impact is limited: teardown, abort and destroySandbox already ran before the status update, so only the audit tombstone is left incomplete (ADR 0006 calls the second-delete case harmless).
