### 1. Missing schema is reported as a held lock
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/storage.ts:25,44
- Duplicate of: none
- Reasoning: The vendored adapter's `acquireOwnership` runs `pg_try_advisory_lock(hashtextextended('...' || current_schema(), 0))`; with a missing schema `current_schema()` is NULL, the lock result is not `true`, and it throws "Storage is in use or its schema does not exist; only one owner is supported". `LOCK_HELD = /only one owner is supported|in use/` matches, so the loop logs only `waiting-for-lock` (no message) and retries forever. config.ts says the schema "must exist", and deploy/postgres.yaml creates it, so only a misconfiguration triggers it; the cost is a misleading diagnostic.
