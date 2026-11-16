### 1. Log polling can prevent the script from returning a verdict
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): tests/e2e/run.sh:156-158, 173-175
- Duplicate of: none
- Reasoning: The background subshell loops `until k logs "job/$job" --tail=1 ...; do sleep 2; done` and only then runs `logs -f`. `pkill -f "logs -f job/$job"` cannot match while the loop is still in `until`/`sleep`, and `wait "$follow_pid"` has no timeout. If the Job's pod never produced logs (image pull failure, then activeDeadlineSeconds 3600 -> Failed and pod deleted) the loop never ends and the script hangs after the verdict was already known, defeating the "verdict from Job status" design.

### 2. A new run deletes active driver Jobs
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): tests/e2e/run.sh:85-86
- Duplicate of: none
- Reasoning: The delete-by-label is deliberate (comment: a Job left by an earlier killed run would hold the RWO code volume). It does kill a concurrently running suite and an earlier INCONCLUSIVE Job the script told the operator it kept. But concurrent runs are already unsupported: both share the `e2e-driver` PVC and the loader does `rm -rf /driver/*`, and the namespace is shared. So it is a missing guard for misuse rather than a defect in the supported flow.

### 3. The full suite continues after leaving an unfinished Job running
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run.sh:197-201, 209
- Duplicate of: none
- Reasoning: The INCONCLUSIVE branch sets `keep_job=1` and `overall=2` but `for phase in "${phases[@]}"; do run_phase "$phase"; done` carries on, creating the next Job while the old one may still run against the same cluster resources and driver volume. Trigger: both `kubectl wait` processes exit without a Complete/Failed condition (API/connection loss during the wait) and the subsequent `get job` also fails, in an `all` run. Rare, only affects `all`.
