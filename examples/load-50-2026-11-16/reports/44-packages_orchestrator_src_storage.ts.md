## Findings
### 1. Missing schema is reported as a held lock
- Severity: low
- Confidence: high
- Location: packages/orchestrator/src/storage.ts:44
- What happens: If the configured schema does not exist, the adapter reports that storage is in use **or** the schema does not exist. This code classifies that error as lock contention and logs only `waiting-for-lock`, then retries indefinitely. An operator is therefore directed to wait for another owner rather than fix the missing schema.
- Evidence: `const LOCK_HELD = /only one owner is supported|in use/;`
- Fix idea: Check that the configured schema exists before entering the lock retry loop, and report a distinct configuration error if it does not.

END-OF-REPORT
