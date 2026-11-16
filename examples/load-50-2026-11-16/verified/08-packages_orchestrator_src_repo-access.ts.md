### 1. Teardown can race with token renewal and recreate access after deletion
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/repo-access.ts:255-262
- Duplicate of: none
- Reasoning: In `#delete` (sessions.ts:301) `repos.teardown` runs before `host.abort`, so a running tool call can be in `beforeUse -> ensureAccess -> #ensure` (tracked only in `#inFlight`) while `teardown` does `#forget` and `#revoke`; the renewal can create agent/secrets after the revoke listed them. Renewal only happens within `REMINT_BEFORE_MS` of the hour-long token expiry, which narrows it a lot, and the orphan sweep (ADR 0002: deleted session's OneCLI agents are swept) removes the leftover after grace.

### 2. A failed grant check can permanently invalidate an open environment's proxy token
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/repo-access.ts:156-163 (env token set at :89 / sandboxes.ts:356)
- Duplicate of: none
- Reasoning: If `#narrow` throws during a renewal (e.g. a transient `listGrants` error), `#revoke(session.id, agent.id, ...)` deletes the agent and `#access` is cleared; the next `beforeUse` creates a new agent with a new `accessToken`, but the open env's `shellEnv` was built once from the old token at open (`buildShellEnv({ token: access.proxyToken })`), so subsequent git/HTTP through the gateway use a dead token until the env is reopened (idle suspend/restart). Needs a transient failure at renewal time.

### 3. Prepared-session cache bypasses workspace-loss detection
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/repo-access.ts:228
- Duplicate of: none
- Reasoning: `#prepared` is only cleared by `#forget`; after the first `prepareWorkspace`, later `prepare` calls return at :228 without re-checking the marker/clone, and it is not cleared on Pod recycle or idle suspend. If the workspace PVC is lost or an operator recreates the claim/PVC (ADR 0001 describes that) without an orchestrator restart, the next input runs in an empty workspace instead of failing with `WorkspaceLostError`. Requires out-of-band workspace loss while the process stays up.
