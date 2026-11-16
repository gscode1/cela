### 1. Claim ownership check races with deletion
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/kube.ts:144-157
- Duplicate of: none
- Reasoning: The label check at :144 is a one-time read and `deleteNamespacedCustomObject(claim)` at :157 has no UID precondition, so check-then-delete is formally racy (ADR 0002 even claims the label check protects "a claim that changed hands"). But the claim name is `pi-conv-<conversationId>`, unique per conversation, and deleting sessions are not recreated; a different session owning the same name does not occur, and for the orphan PVC case a claim re-appearing needs the same conversation id to be re-provisioned within the grace window. Mechanism real, no realistic trigger.

### 2. Claim disappearance does not guarantee the Sandbox is gone
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/kube.ts:157-161
- Duplicate of: none
- Reasoning: `deleteNamespacedCustomObject(claim)` is a plain delete (background GC), so the claim can 404 while its Sandbox still exists, and the PVC delete could be followed by the Sandbox controller recreating `workspace-<claim>`. The code comment names this exact hazard but only waits for the claim. However, a PVC mounted by the still-running Pod stays Terminating (pvc-protection) until the Pod, which is owned by the Sandbox, is gone, and the loop only returns once the PVC itself 404s, so recreation needs the Sandbox to outlive the Pod/PVC termination. Possible only with a stalled GC; the orphan sweep also backstops it.
