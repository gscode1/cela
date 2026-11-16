### 1. One stalled submission blocks all run watches
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/watcher.ts:61-79
- Duplicate of: none
- Reasoning: The loop awaits `lookup` then `onUnanswered` serially under `if (this.#polling) return`. `onUnanswered` is `SessionService.#runEnded` -> `#failSession` -> `host.abort(conversationId)`, documented as "aborts the running turn and resolves once the conversation is idle", so a session whose abort drains slowly (long tool call) delays failure detection for every later watch; ticks during that time are dropped. Lookups are bounded by the pg pool's statement_timeout (30s), and abort ends the run, so the effect is delayed marking of other failed sessions, not a permanent block; severity lowered.
