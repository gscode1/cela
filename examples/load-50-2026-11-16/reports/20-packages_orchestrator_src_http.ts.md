## Findings

### 1. A stream can open after session deletion has closed its streams
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/http.ts:96
- What happens: A stream request can read a session before or during deletion, then register its stream after deletion has already called `closeSession`. The stream remains open without receiving the `deleted` event, even after the session is marked deleted. A request for a session already in `deleting` state is also allowed through this check.
- Evidence: `if (session.status === "deleted")` is followed by `await service.ensureConversation(session)` and `await serveStream(...)`; stream registration happens later, after `host.watch`.
- Fix idea: Coordinate stream registration with deletion and recheck session status after registration, closing the stream if deletion has begun or completed.

END-OF-REPORT
