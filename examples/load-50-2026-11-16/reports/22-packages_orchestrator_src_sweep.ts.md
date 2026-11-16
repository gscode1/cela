## Findings

### 1. A stale session snapshot can cause a live session’s credentials to be revoked
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sweep.ts:131
- What happens: The sweeper lists sessions and OneCLI objects concurrently. If the session query finishes before a new session is created but the OneCLI listing sees its newly created secret, the planner treats the session as unknown and schedules revocation. Execution revokes the session’s agent and secrets by name, breaking the live session. The same race applies to an agent with no creation timestamp.
- Evidence: `if (orphanReason(bySession.get(sessionId)) !== undefined) entry(sessionId).secretIds.push(secret.id);`
- Fix idea: Recheck session ownership against the database immediately before revocation. Also apply a grace period to OneCLI objects where creation timestamps are available, including secrets.

### 2. Repeatedly failing actions can starve the rest of the sweep
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sweep.ts:143
- What happens: If the first `maxActions` candidates consistently fail deletion—for example, because Kubernetes denies access—the same candidates can occupy every run’s action budget. Later orphan PVCs and agents are never attempted, leaving resources and potentially valid agent tokens behind indefinitely.
- Evidence: `return actions.slice(0, Math.max(0, input.maxActions));`
- Fix idea: Rotate or otherwise track candidate ordering across runs, or apply the success limit while allowing later candidates to be attempted after failures.

END-OF-REPORT
