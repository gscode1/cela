### 1. A crash can leave a session deleting without a delete event
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/session-core/src/store.ts:266-271 (caller packages/ingest/src/server.ts:248-255)
- Duplicate of: 10-packages_ingest_src_server.ts #1
- Reasoning: `requestDelete` commits `status='deleting'` in its own statement and `queueDelete` then calls `enqueueEvent` separately; a crash/DB error between leaves `deleting` with no delete row, and nothing recovers it (sweep treats `deleting` as live, ADR 0002/0006 only retry existing rows). A client retry of DELETE heals it (`requestDelete` is idempotent, `enqueueEvent` is deduplicated), and a DB error surfaces as a 500 to the client, so this needs an ingest crash plus a client that does not retry. The real defect is in the caller's non-atomic sequence, not in this function. Low, not high.
