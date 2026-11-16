### 1. Failed sessions can resume before their recovery abort
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/main.ts:110-133 (host.ts:114 `harness.resume()`, sessions.ts:124 `#recoverFailedAborts`)
- Duplicate of: none
- Reasoning: The ordering is as described: `Host.open` calls `harness.resume()` before `recoverWatches()` aborts recently failed sessions, so a conversation of a session marked failed but not aborted (crash between failSession and abort, the exact case `#recoverFailedAborts` exists for) can start running in that gap. Needs a crash in that narrow window and the gap is short (one DB query), and the abort does follow; effect is at most a few extra steps.

### 2. Shutdown can miss a host opened during startup
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/main.ts:51, 110-134
- Duplicate of: none
- Reasoning: `lifecycle.host` is assigned only at line 134 after `recoverWatches`; a SIGTERM in between runs `shutdown`, skips `host.close()` (and `running.inbox`/`sweeper` are unset) and `process.exit(0)` follows. Meanwhile main() continues and starts the sweeper and inbox after shutdown began. The window is the duration of recoverWatches only, and Pi Durable recovers interrupted runs by design (process death is the normal failure mode), so the effect is an ungraceful stop.
