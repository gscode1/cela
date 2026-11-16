## Findings

### 1. Teardown can race with token renewal and recreate access after deletion
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/repo-access.ts:255
- What happens: A tool call can already be renewing access when session deletion calls `teardown`. Teardown does not wait for or cancel that work, so it can revoke the existing objects and finish before the renewal creates a new agent and secrets. The deleted session can consequently retain live OneCLI access until a later orphan sweep.
- Evidence: `this.#forget(session.id);` followed by `await this.#revoke(...)`, while `ensureAccess` tracks work separately in `#inFlight`.
- Fix idea: Serialize teardown with provisioning per session and prevent new provisioning once deletion begins. Wait for any existing provisioning to settle before the final revoke.

### 2. A failed grant check can permanently invalidate an open environment’s proxy token
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/repo-access.ts:156
- What happens: If a grant check fails transiently during renewal, the existing agent is deleted. A retry creates a new agent with a new proxy token, but the already-open environment still has the old token in its shell environment. Subsequent commands therefore continue using a revoked token even though renewal succeeds.
- Evidence: `await this.#revoke(session.id, agent.id, secretIds)`; `beforeUse` subsequently calls `await this.ensureAccess(session)` without updating the environment’s token.
- Fix idea: Reopen or update the environment when its agent token changes, or preserve the existing agent when it is safe to do so.

### 3. Prepared-session cache bypasses workspace-loss detection
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/repo-access.ts:228
- What happens: After the first successful preparation, if the repository or workspace marker is removed while the orchestrator remains running, later inputs skip `prepareWorkspace`. The session can continue without detecting the lost workspace, despite the intended failure rather than silently working in the wrong workspace.
- Evidence: `if (this.#prepared.has(session.id)) return;`
- Fix idea: Recheck the marker and repository before subsequent turns, even when cloning and CA setup can be skipped.

END-OF-REPORT
