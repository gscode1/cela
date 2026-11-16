## Findings

### 1. Inconsistent snapshots can revoke a live session’s credentials
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sweeper.ts:54
- What happens: The session list can be read before a new session is created, while the OneCLI list is read after that session provisions its agent. The planner then sees the agent as belonging to an unknown session and revokes its credentials, disrupting the live session. OneCLI agents have no creation-time grace check in the production caller.
- Evidence: `Promise.all([d.listSessions(), ... d.listOneCli?.()])`
- Fix idea: Recheck the session’s current status immediately before revoking its OneCLI objects. Coordinate that check with session creation if necessary to prevent a new owner appearing between the check and revocation.

### 2. Repeatedly failing actions can starve later orphans
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sweeper.ts:68
- What happens: If the first `maxActions` planned actions repeatedly fail—for example, because their claims cannot be deleted—each run selects those same actions again. Later PVCs and agents are never reached, so orphaned resources and usable tokens can remain indefinitely.
- Evidence: `maxActions: d.maxActions` followed by a loop that logs failures without changing future selection.
- Fix idea: Rotate or back off failed actions across runs so other candidates get a chance, while retaining the per-run action limit.

### 3. OneCLI listing failure blocks unrelated Kubernetes cleanup
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sweeper.ts:54
- What happens: If OneCLI is unavailable or either of its list requests fails, `Promise.all` rejects and the sweep performs no claim or PVC cleanup, even when Kubernetes and the session database are healthy. A prolonged OneCLI outage therefore leaves orphaned sandboxes and storage running.
- Evidence: `d.listOneCli?.()` is included in the same `Promise.all` as the Kubernetes and session lists.
- Fix idea: Handle OneCLI listing failure separately and run the Kubernetes portion with agents undefined; log the OneCLI failure and retry it on the next run.

END-OF-REPORT
