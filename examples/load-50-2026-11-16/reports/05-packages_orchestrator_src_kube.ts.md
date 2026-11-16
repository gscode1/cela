## Findings

### 1. Claim ownership check races with deletion
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/kube.ts:157
- What happens: A claim can be created or replaced after the ownership check but before a delete in the loop. The delete is by name alone, so teardown can delete a different session’s claim and then its workspace PVC. This also affects the orphan-PVC sweep when a claim appears after the initial 404.
- Evidence: `getNamespacedCustomObject(claim)` checks the label once; subsequent iterations call `deleteNamespacedCustomObject(claim)` without a UID precondition.
- Fix idea: Bind deletion to the checked claim UID with a Kubernetes delete precondition. If the initial lookup returns 404, do not delete a subsequently appearing claim; recheck ownership before any deletion.

### 2. Claim disappearance does not guarantee the Sandbox is gone
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/kube.ts:157
- What happens: Kubernetes can delete the claim using background cascading deletion, so the claim may return 404 while its dependent Sandbox is still being reconciled. The function can then delete the PVC, observe it gone, and return before that Sandbox recreates it, leaving an orphan workspace after teardown reports success.
- Evidence: `const pvcPresent = claimPresent ? true : await ignoreNotFound(core.deleteNamespacedPersistentVolumeClaim(pvc));`
- Fix idea: Use foreground cascading deletion and wait for the claim and its dependents to disappear before deleting the PVC, or explicitly wait for the Sandbox to be gone.

END-OF-REPORT
