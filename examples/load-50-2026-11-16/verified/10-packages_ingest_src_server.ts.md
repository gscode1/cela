### 1. Interrupted DELETE can leave a session permanently stuck deleting
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/ingest/src/server.ts:248-255
- Duplicate of: 04-packages_session-core_src_store.ts #1
- Reasoning: `await requestDelete(pool, session.id)` commits `deleting`, then `enqueueEvent` is a separate statement; a crash or DB failure between leaves `deleting` with no delete row and no recovery path (events are rejected for non-active sessions; sweep treats `deleting` as live). The client sees an error/connection reset and a repeated DELETE re-runs both steps idempotently, so permanent only if the client never retries. "Permanently stuck" overstated.
