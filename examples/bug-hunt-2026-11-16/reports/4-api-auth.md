## Findings

### 1. Client event IDs can prevent session deletion
- Severity: high
- Confidence: high
- Location: packages/ingest/src/server.ts:227
- What happens: An owner can post an event with `sourceEventId` equal to `delete:<session-id>`, then delete that session. The delete enqueue is treated as a duplicate of the earlier event, but the session is still marked `deleting`. No delete event exists to revoke credentials or remove the sandbox, and repeated DELETE requests cannot fix it. The same ID used in another session produces a conflict with the same result.
- Evidence: DELETE uses `sourceEventId: \`delete:${session.id}\`` and then calls `requestDelete` even when enqueue returns a conflict. Client-supplied IDs are not reserved, and deduplication checks only source, ID and session—not event kind.
- Fix idea: Put internal delete events in a separate deduplication namespace from client events. Only mark the session deleting when a genuine delete event has been inserted or verified.

### 2. Event admission races with deletion
- Severity: medium
- Confidence: high
- Location: packages/ingest/src/server.ts:81
- What happens: A POST can load an active session and then wait while its body is sent. A concurrent DELETE can queue and complete deletion before that POST resumes. The POST still uses its stale session status, inserts an event, and returns 202, although the orchestrator subsequently rejects the event because the session is deleted.
- Evidence: The route loads `session` before reading the body; `postEvent` later checks `session.status !== "active"` and calls `enqueueEvent`, whose insert has no current-status condition.
- Fix idea: Serialize event admission and deletion using a transaction and session-row lock, checking the current status while inserting. Queue the delete and change the status atomically under the same lock.

### 3. A temporarily failing deletion becomes permanently unretryable
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/inbox.ts:177
- What happens: If teardown fails five times—for example, because Kubernetes or OneCLI is temporarily unavailable—the delete event is marked failed. The session remains `deleting`, potentially retaining its sandbox or credentials. A later DELETE is deduplicated against that failed event rather than requeued, so recovery of the dependency does not complete cleanup.
- Evidence: The inbox marks an event permanent when `attempt >= MAX_ATTEMPTS`; DELETE always reuses `delete:${session.id}`, and `enqueueEvent` returns the existing event as a duplicate regardless of its status.
- Fix idea: Retry cleanup until it succeeds, with bounded backoff and alerting, or allow a subsequent DELETE to requeue a failed delete event safely.

## Areas checked with no findings
- Authentication and owner checks on ingest routes and the orchestrator stream route.
- Constant-time static-token comparison.
- SQL parameterization and migration ordering.
- Repository and branch validation, JSON body size limits, and generic server error responses.

END-OF-REPORT
