### 1. Cleanup can delete a claim this run never created
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): tests/e2e/run-phase1.sh:31-38 (trap) and :41
- Duplicate of: none
- Reasoning: The trap is installed at line 39, before the `[[ -s $bundle ]] || fail` check at line 41, so an early exit deletes `$claim` even though nothing was created. But `claim=${CLAIM:-e2e-phase1}` is a name dedicated to this script (the ADR 0002 sweep and the header say so) and line 66 deletes the same claim unconditionally anyway; harm exists only if an operator overrides `CLAIM` to a real session's claim.

### 2. The PVC deletion wait can fail immediately and is ignored
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase1.sh:67; tests/e2e/driver/driver-rbac.yaml:38-39
- Duplicate of: none
- Reasoning: The driver Role grants `persistentvolumeclaims` only `[get, list, delete]`, and `kubectl wait --for=delete` on an existing object uses a watch, so it fails with Forbidden; `>/dev/null 2>&1 || true` hides it and the script proceeds to create the claim while the old PVC may still be terminating. Effect is a possibly reused/stale workspace PVC in a test; if the PVC is already gone the wait succeeds trivially.

### 3. The namespace override does not apply to the runner manifest
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase1.sh:21,46; tests/e2e/runner-pod.yaml:6
- Duplicate of: none
- Reasoning: `k` runs `kubectl -n "$ns"` and `runner-pod.yaml` hard-codes `namespace: pi-durable-poc`; with `NAMESPACE` set otherwise, `kubectl create -f` errors on the namespace mismatch. Test-only knob, and the whole e2e setup (RBAC, SA, template) is tied to that namespace anyway.
