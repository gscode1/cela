### 1. A multi-event batch can deadlock while updating its session
- Verdict: CONFIRMED (mechanism real, but not permanent as reported)
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/inbox.ts:170 (lock taken), sessions.ts:273 (#delete) and sessions.ts:133 (failSession via #prepareRepo/#withinBudget)
- Reasoning: In `#applyRow`, after event 1 the tx on `client` runs `update inbox.sessions set last_activity_at ...` and holds that row lock until `commit` (inbox.ts:146). If event 2 in the same batch is a `delete`, `#delete` runs `this.#pool.query("update inbox.sessions set status = 'deleted' ...")` on a different pool connection, which blocks on that lock while the inbox tx awaits `#apply`: a cross-connection wait PG cannot detect. The same applies to a `failSession(this.#pool, ...)` from `#prepareRepo`/`#withinBudget` on a later message event. However the report's "never commits" is wrong: `createPool` sets `statement_timeout: 30_000` / `query_timeout: 35_000`, so the blocked update errors after 30s, `#applyRow` catches it (non-Permanent), marks the row pending and returns "retry-later", and the tx commits; the retry then has the delete first in its batch and works. Real effect is a ~30s stall of that session's drain per occurrence (message then delete within one poll tick is easy to hit), plus delete side effects re-run (tombstone, teardown, abort, destroySandbox) and attempts burned.

### 2. A failed session can retain running or queued work after abort fails
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/sessions.ts:133-137
- Reasoning: `#failSession` does `const changed = await failSession(...); if (!changed) return;` and only afterwards `await this.#host.abort(conversationId)`. `failSession` is `update ... where id = $1 and status = 'active'`, so any retry sees 0 rows. Trigger: the watcher path `#runEnded` -> `#failSession`; DB update commits, then `host.abort` throws (storage hiccup) or the process dies. The watcher keeps the entry pending and retries, but now `changed` is false so abort is never retried; recoverWatches selects only `s.status = 'active'`, so restart does not help either. In the `#prepareRepo`/`#withinBudget` paths the thrown abort error also leaves the session failed with no abort; later inputs get PermanentError("session has failed"). Needs a transient fault or crash in a narrow window and the cost is only queued inputs still running, hence medium not high.

### 3. Watch recovery silently omits older or high-volume submissions
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:105-106
- Reasoning: The query does have `e.submitted_at > clock_timestamp() - interval '24 hours'` and `order by e.submitted_at desc limit 1000`, so older or surplus submissions are not re-watched after a restart. But it is a deliberate, documented bound ("handed over recently"; main.ts: "a run that died unseen is noticed at its next input"), and needs a run still unsettled after >24h, or >1000 message/steer submissions on active sessions within 24h, before a restart. In a PoC that is unlikely. Turn-limit failures are still caught at the next input by `#withinBudget`; only rejected credentials on such a run would go unnoticed until a later watched run fails.

### 4. SSE backpressure accumulates unused close listeners
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/stream.ts:84
- Reasoning: `await Promise.race([once(res, "drain"), once(res, "close")])` uses `events.once` without a signal, so when `drain` wins, the `close` (and `error`) listeners registered by the losing `once` stay on `res` until the socket closes. Each backpressure cycle on one long-lived stream adds another pair; beyond 10 `close` listeners Node emits MaxListenersExceededWarning. Memory per leak is tiny and everything is freed at connection close, so impact is warnings/minor growth for long-lived slow clients, not "indefinite" growth in a bounded sense. Medium severity is overstated.

Totals: confirmed=3 plausible=1 rejected=0
