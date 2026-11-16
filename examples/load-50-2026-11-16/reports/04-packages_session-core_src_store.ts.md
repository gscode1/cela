## Findings

### 1. A crash can leave a session deleting without a delete event
- Severity: high
- Confidence: high
- Location: packages/session-core/src/store.ts:266
- What happens: If ingest crashes after `requestDelete` commits but before it enqueues the delete event, the session remains in `deleting` with no event to trigger cleanup. Its sandbox and credentials can remain provisioned indefinitely unless the client retries DELETE.
- Evidence: `requestDelete` independently executes `update inbox.sessions set status = 'deleting'`; its caller subsequently calls `enqueueEvent` in a separate operation.
- Fix idea: Change the status and insert the deduplicated delete event in one transaction, or add recovery that enqueues missing delete events for sessions stuck in `deleting`.

END-OF-REPORT
