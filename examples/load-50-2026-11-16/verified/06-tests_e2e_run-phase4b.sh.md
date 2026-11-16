### 1. Cleanup fails when no sessions were created
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4b.sh:98
- Duplicate of: none
- Reasoning: Reproduced the pattern: under `set -euo pipefail`, `list=$(grep -v '^$' "$f" | sed ... | paste -sd, -)` with an empty file makes grep exit 1, the assignment fails, the EXIT trap aborts (bash run: "after" never printed, rc=1) so `rm -rf "$work"` is skipped and the script exits 1. Triggers when no test creates a session (`ONLY=disallowed`, or creation failing so nothing is appended at :160). The default full run creates sessions in `models`/`failed-401`, so it is a debugging-mode annoyance.

### 2. Failed inspection commands can pass security and log assertions
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4b.sh:239 (also :213, :262)
- Duplicate of: none
- Reasoning: `if k exec ... | grep -q ...; then FAIL; else ok` treats a failing `kubectl exec` (empty output) the same as "no key present"; likewise `orch_log | grep -q` at :213/:262 passes when `k logs` fails. The SIGPIPE-with-pipefail sub-claim is not realistic: the output is a few lines, well under the pipe buffer, so `cut` finishes writing before `grep -q` exits. The failing-exec false pass is real but only follows a `k get secret` that just succeeded at :232, so it needs a transient API failure.

### 3. Secret lookup errors are reported as a legitimate skip
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4b.sh:232-236
- Duplicate of: none
- Reasoning: `if ! k get secret pi-onecli >/dev/null 2>&1; then ... return 3` maps any kubectl failure (RBAC, outage) to SKIP, which `run` counts as skipped, not failed, so a requested REAL_MODEL=1 run can end "all tests passed" without testing the real models. The summary does print SKIP, so it is visible.
