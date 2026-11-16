### 1. Client event IDs can prevent session deletion
- Verdict: CONFIRMED
- Severity (verified): medium (needs the owner to do it to their own session; consequence is leaked sandbox/OneCLI credentials until an operator acts, so high only if owners are untrusted)
- Location (verified): packages/ingest/src/server.ts:227-234 (dedup in packages/session-core/src/store.ts:197-220)
- Reasoning: Client events use `source: \`api:${principal.owner}\`` and a client-chosen `sourceEventId` (events.ts only checks length), and DELETE uses the same source with `sourceEventId: \`delete:${session.id}\``. The unique index `events_source_dedup (source, source_event_id)` has no kind. Sequence: POST /sessions/<id>/events {kind:"message", text:"x", sourceEventId:"delete:<id>"}, then DELETE /sessions/<id>. enqueueEvent's insert conflicts, it returns "duplicate" (or "conflict" if the ID was used on another session), and queueDelete still runs `await requestDelete(pool, session.id)`, setting status to 'deleting'. No kind=delete row exists, so the orchestrator never runs #delete, and sweep.ts treats `deleting` as live. Repeat DELETEs hit the same duplicate. The session also now rejects new events (409), so it is stuck. The owner-only precondition is why this is not high.

### 2. Event admission races with deletion
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/ingest/src/server.ts:81 (session loaded), 188-210 (stale status check, enqueue)
- Reasoning: `ownedSession` loads the row before `postEvent` awaits `readJsonObject(req)`; the `session.status !== "active"` check uses that stale object and `enqueueEvent` inserts without any status condition. A client that sends headers, stalls the body while DELETE completes (status 'deleted'), then finishes the body gets 202 with an eventId. The orchestrator then throws `PermanentError("session is deleted")` in `apply`, so the row is marked failed. Impact is only a misleading 202 plus a dead inbox row: no resource is created or leaked, since deleted sessions are never applied. Severity is low, not medium.

### 3. A temporarily failing deletion becomes permanently unretryable
- Verdict: CONFIRMED
- Severity (verified): high
- Location (verified): packages/orchestrator/src/inbox.ts:177-190 (plus ingest/src/server.ts:227-234, store.ts:212-220)
- Reasoning: `#applyRow` sets `permanent = error instanceof PermanentError || attempt >= MAX_ATTEMPTS` (5) and writes status 'failed'; with POLL_MS = 1_000 the five attempts span only seconds, so a short K8s/OneCLI outage exhausts them. #delete's teardown/destroySandbox errors are not PermanentError, so they are retried then marked failed. The session stays 'deleting' (status only becomes 'deleted' at the end of #delete). No code path ever resets a failed event to pending (grep of `set status` shows none). A later DELETE calls enqueueEvent with the same `delete:<id>` key, gets "duplicate" regardless of the old row's status, and requestDelete does nothing for 'deleting'. The orphan sweep also treats `deleting` sessions as live, so the sandbox, PVC and OneCLI agent are never cleaned.
