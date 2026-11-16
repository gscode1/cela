### 1. Failed control-session creation can leak a sandbox
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/host.ts:128-134
- Duplicate of: none
- Reasoning: `startSession` calls `sandboxes.ensure(id)` then `conversation.submit(...)` with no cleanup; a failure after the claim exists returns an error without the id, and sweep.ts:13 leaves `control-<n>` claims alone. But this is the test-only `/control` path (`deps.control`), not the session API, so the leak is limited to e2e runs against a lab namespace (and e2e cleanup).
