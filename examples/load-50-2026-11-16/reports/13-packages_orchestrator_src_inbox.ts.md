## Findings

### 1. Pending sessions can starve behind backed-off deletes
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/inbox.ts:110
- What happens: If the query repeatedly returns the same 100 sessions with failing deletes, their rows remain pending even while they are in backoff. Other pending sessions outside that result can be omitted on every poll and never processed.
- Evidence: `"select distinct session_id from inbox.events where status = 'pending' limit 100"` is followed by an in-memory `#notBefore` check.
- Fix idea: Make selection fair across all pending sessions, for example by paginating or rotating through session IDs, and ensure backed-off sessions do not consume the entire selection limit.

### 2. A delete can be marked failed after partially completing
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/inbox.ts:198
- What happens: Delete processing marks the session deleted before completing its tombstone and before the inbox transaction commits. If tombstone completion fails or the process crashes in that window, the retry sees a deleted session; `SessionService.apply` throws `PermanentError`, so the inbox marks the delete failed rather than completing the remaining work.
- Evidence: `await this.#apply(event, session)` precedes the event status update, and `PermanentError` is treated as permanent.
- Fix idea: Make delete retries idempotently finish cleanup even when the session is already deleted, and only mark the inbox row submitted after all delete steps complete.

END-OF-REPORT
