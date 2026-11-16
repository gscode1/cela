### 1. Clearing the in-flight record can race with the next command
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sandboxes.ts:202-210 (set at :158-160)
- Duplicate of: none
- Reasoning: `#settle` sets `usage.recorded = false` and fires `void execInFlight(conv, false)` without awaiting; the next exec sees `!usage.recorded` and issues `execInFlight(conv, true)` (a separate `pool.query`, possibly another connection). The two updates are not ordered, so `false` can land after `true` and leave `exec_in_flight_at` null during a running command, defeating the crash-recycle. In practice the next exec first passes `#awaitCleanPod`, `beforeUse` and `ensure` (ms of awaits) after the clear was already dispatched, so reordering needs a slow clear (DB stall, up to statement_timeout) combined with a restart in that command. Unlikely; not high.
