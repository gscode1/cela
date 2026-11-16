## Findings

### 1. Cleanup fails when no sessions were created
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4b.sh:98
- What happens: A successful run with `ONLY=disallowed`, or a run where the real-model test is skipped and no other test runs, reaches cleanup with an empty sessions file. `grep` returns 1, so `set -e` aborts the EXIT trap, changes the script’s exit status to failure, and leaves the temporary directory behind.
- Evidence: `list=$(grep -v '^$' "$sessions_file" | sed "s/.*/'&'/" | paste -sd, -)`
- Fix idea: Treat an empty sessions file as a normal case when building `list`, and ensure cleanup still removes the temporary directory.

### 2. Failed inspection commands can pass security and log assertions
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4b.sh:239
- What happens: If `kubectl exec` fails, the environment check reports that no provider key is present even though it could not inspect the environment. The log checks at lines 213 and 262 similarly report success when fetching orchestrator logs fails. With `pipefail`, an upstream command terminated after `grep -q` finds a match can also make a matching pipeline appear unsuccessful.
- Evidence: `if k exec deploy/pi-orchestrator -- sh -c 'env | cut -d= -f1' | grep -q -E ...; then`
- Fix idea: Capture and validate the inspection command’s output and exit status separately, then search the captured output. Fail the test if inspection fails.

### 3. Secret lookup errors are reported as a legitimate skip
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4b.sh:232
- What happens: When the real-model test is requested, a Kubernetes authorization error, API outage, or other `kubectl` failure is reported as the secret being absent. The test is skipped rather than failed, potentially yielding a successful acceptance run without exercising real models.
- Evidence: `if ! k get secret pi-onecli >/dev/null 2>&1; then`
- Fix idea: Distinguish a genuine NotFound response from other lookup failures, and fail the test for errors that prevent determining whether the secret exists.

END-OF-REPORT
