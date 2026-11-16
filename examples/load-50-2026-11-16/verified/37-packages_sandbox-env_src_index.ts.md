### 1. A failed bridge start delays unrelated sandboxes
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/sandbox-env/src/index.ts:51-59 (with start-gate.ts:79-86)
- Duplicate of: none
- Reasoning: `gatedStart` frees the turn only on the BRIDGE_READY log, on `close()`, or on the next `command()` call (`free()` at its start). pi-env's Connection (connection.js:270-278) rejects with "exited ... before it was ready" without calling anything on the gate, and only calls `command()` again on the next request. So a bridge that exits early (bad claim, connection refused) keeps the process-wide gate held until the 45s `setTimeout(release)` or until that session retries; other sandboxes' starts queue behind it, risking pi-env's 30s start timeout noted in start-gate.ts. Medium: transient, self-healing.
