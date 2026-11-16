### 1. Inconsistent snapshots can revoke a live session's credentials
- Verdict: PLAUSIBLE
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/sweeper.ts:54-59 (consumed in sweep.ts:128-141; revoke at repo-access.ts:271)
- Duplicate of: 22 #1
- Reasoning: Same mechanism: independent concurrent reads, secrets with no grace check, agents without `createdAt` (main.ts:148 maps only id/identifier), and `revokeSession` deletes by name with no DB recheck. The window is the OneCLI listing latency, within which a brand-new session must already have provisioned its agent/secrets (needs sandbox ready and a GitHub token mint), so it is very unlikely at a 300 s cadence.

### 2. Repeatedly failing actions can starve later orphans
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sweeper.ts:62-79 with sweep.ts:143
- Duplicate of: 22 #2
- Reasoning: The cap is applied to the planned list in fixed order before execution and failures are only logged (`sweep-action-failed`), so the same 10 failing actions are re-planned each run. Requires 10 or more persistently failing orphans; ADR 0002 accepts "the rest waits".

### 3. OneCLI listing failure blocks unrelated Kubernetes cleanup
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sweeper.ts:54-59, 79-81
- Duplicate of: none
- Reasoning: `d.listOneCli?.()` is in the same `Promise.all`; if either OneCLI list call rejects, the whole run lands in `catch` -> `sweep-failed` and no claim/PVC is processed. During a OneCLI outage orphan claims/PVCs accumulate until it recovers. It is logged and self-heals; orphans are a resource leak, not a correctness failure, hence low.
