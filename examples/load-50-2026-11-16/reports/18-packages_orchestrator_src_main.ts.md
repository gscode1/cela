## Findings
### 1. Failed sessions can resume before their recovery abort
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/main.ts:110
- What happens: If the previous process marked a session failed but crashed before aborting its conversation, startup resumes that conversation before `recoverWatches()` reaches the recovery abort. Queued inputs or tools can therefore run for a session that should no longer execute.
- Evidence: `await Host.open(...)` precedes `await service.recoverWatches()`; `Host.open` calls `harness.resume()`, while `recoverWatches` aborts failed conversations.
- Fix idea: Open the harness without resuming it, recover and abort failed conversations, then resume the remaining work.

### 2. Shutdown can miss a host opened during startup
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/main.ts:51
- What happens: If SIGTERM arrives after `Host.open` has resumed work but while `recoverWatches()` is still running, `lifecycle.host` has not yet been assigned. Shutdown skips `host.close()` and exits without waiting for the resumed work to settle.
- Evidence: Shutdown uses `await lifecycle.host?.close()`, but `lifecycle.host = host` occurs only after `await service.recoverWatches()`.
- Fix idea: Register the host for shutdown immediately after it opens, and coordinate startup with the abort signal so shutdown cannot race with further initialization.

END-OF-REPORT
