### 1. Orphan-sweep test can overwrite and delete an existing claim
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4.sh:631 (mkclaim at :199-202, cleanup :84-86)
- Duplicate of: none
- Reasoning: `mkclaim pi-conv-990001` uses `k apply` and registers the name for unconditional deletion, so a pre-existing claim of that name would be overwritten and deleted. But real claims are named `pi-conv-<conversationId>` from a serial id, so a collision needs conversation id 990001 (or two concurrent e2e runs in the same namespace, which already conflict on much else). Mechanism is real, trigger practically only a parallel run or a stale leftover (which is the intended overwrite). Test-only, lab cluster.

### 2. Cleanup drops session records even when API deletion failed
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4.sh:81-83 (row delete at :83)
- Duplicate of: none
- Reasoning: When `undeleted_sessions` still lists the id after the 240 s deadline, cleanup deletes claim and PVC with `kubectl delete` and then runs `delete from inbox.events ...; delete from inbox.sessions ...` regardless, so the orchestrator's delete (and OneCLI revoke for repo sessions) can never retry. Impact is bounded: phase4 sessions are mostly plain sessions (no repo/OneCLI objects), and ADR 0002 says a hard-deleted session's leftovers are swept as `session-unknown`. Test cleanup only.
