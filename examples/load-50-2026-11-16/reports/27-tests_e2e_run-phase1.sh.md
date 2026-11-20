## Findings

### 1. Cleanup can delete a claim this run never created
- Severity: high
- Confidence: high
- Location: tests/e2e/run-phase1.sh:37
- What happens: If the bundle is missing or runner startup fails, the EXIT trap still deletes the claim named by `CLAIM`, including any pre-existing workspace associated with it. This can happen before the script reaches its explicit claim deletion or creation.
- Evidence: `k delete sandboxclaim "$claim" --ignore-not-found --wait=false`
- Fix idea: Use a unique claim name per run and track whether this run created it. Only delete a claim that the run owns.

### 2. The PVC deletion wait can fail immediately and is ignored
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase1.sh:67
- What happens: When a previous workspace PVC still exists, `kubectl wait` needs to watch it, but the driver Role lacks the PVC `watch` permission. The suppressed failure lets the script create the replacement claim before the old PVC is gone, potentially reusing a stale workspace or racing its deletion.
- Evidence: `k wait --for=delete "pvc/workspace-$claim" --timeout=120s >/dev/null 2>&1 || true`
- Fix idea: Grant the driver PVC watch permission and treat an unsuccessful wait as an error before creating the claim.

### 3. The namespace override does not apply to the runner manifest
- Severity: low
- Confidence: high
- Location: tests/e2e/run-phase1.sh:46
- What happens: Setting `NAMESPACE` to anything other than `cela-dev` causes runner creation to fail because `runner-pod.yaml` explicitly specifies `cela-dev`, conflicting with the namespace passed to kubectl.
- Evidence: `k create -f "$here/runner-pod.yaml"`; the manifest sets `namespace: cela-dev`.
- Fix idea: Remove the hard-coded namespace from the runner manifest or render it using the selected namespace.

END-OF-REPORT
