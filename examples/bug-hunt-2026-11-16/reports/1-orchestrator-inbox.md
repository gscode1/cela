## Findings

### 1. A multi-event batch can deadlock while updating its session
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/inbox.ts:137
- What happens: After applying the first event in a batch, the inbox transaction updates and locks the session row. If a later event in that batch is a delete, its handler uses another pool connection to update the same session row. That update waits for the inbox transaction, while the inbox transaction waits for the handler. The batch never commits, and subsequent events for the session remain pending. The same pattern can occur when a later event attempts to fail the session.
- Evidence: The batch calls `await this.#applyRow(client, event)` before `commit`; `#applyRow` updates `inbox.sessions`, while `SessionService.#delete` separately awaits `this.#pool.query("update inbox.sessions ...")`.
- Fix idea: Avoid holding a session-row lock across calls that can update that row on another connection. Commit per event or perform all related session updates through the same transaction.

### 2. A failed session can retain running or queued work after abort fails
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:133
- What happens: If the process crashes after marking a session failed but before aborting its conversation, or if `abort` throws, queued or running work can continue or resume despite the terminal status. A watcher retry does not repair this: `failSession` returns false for the already-failed session, causing an early return before abort. Startup watch recovery also selects only active sessions.
- Evidence: `const changed = await failSession(...)` is followed by `if (!changed) return;` and only then `await this.#host.abort(conversationId)`.
- Fix idea: Make aborting a failed session a retryable, idempotent cleanup step independent of whether the status update changed a row. Recover incomplete cleanup on startup.

### 3. Watch recovery silently omits older or high-volume submissions
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:101
- What happens: After a restart, a run submitted more than 24 hours ago, or outside the newest 1,000 submitted events, is not watched. If it subsequently settles with rejected credentials or a turn-limit failure, the session can remain active instead of being marked failed and having queued work withdrawn.
- Evidence: Recovery filters on `e.submitted_at > clock_timestamp() - interval '24 hours'` and uses `order by e.submitted_at desc limit 1000`.
- Fix idea: Persist which submissions still need failure reconciliation and recover all of them, paginating if necessary.

### 4. SSE backpressure accumulates unused close listeners
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/stream.ts:84
- What happens: Each time a slow SSE client causes `res.write` to return false and the response later drains, the losing `once(res, "close")` listener remains registered until the connection closes. A long-lived slow stream can accumulate listeners and their associated promises indefinitely.
- Evidence: `await Promise.race([once(res, "drain"), once(res, "close")])` does not remove the listener for the event that lost the race.
- Fix idea: Use explicitly managed listeners or abortable `once` calls, and remove or cancel the losing listener whenever either event fires.

## Areas checked with no findings
- LISTEN/NOTIFY gaps: the inbox also polls for pending rows.
- Message submission retry after a crash: inbox row IDs are passed as durable submission request IDs.
- SSE cursor parsing and gap replay.

END-OF-REPORT
