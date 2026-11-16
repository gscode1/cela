## Findings

### 1. Interrupted DELETE can leave a session permanently stuck deleting
- Severity: medium
- Confidence: high
- Location: packages/ingest/src/server.ts:248
- What happens: If ingest crashes or the database becomes unavailable after the status update commits but before the delete event is inserted, the session remains `deleting` without an event for the orchestrator to process. It rejects new events, while its sandbox and other resources remain allocated. Recovery requires the client to retry DELETE.
- Evidence: `await requestDelete(pool, session.id);` is followed by a separate `await enqueueEvent(pool, ...)`.
- Fix idea: Commit the status transition and delete-event insertion in one database transaction, preserving the ordering guarantees for accepted events.

END-OF-REPORT
