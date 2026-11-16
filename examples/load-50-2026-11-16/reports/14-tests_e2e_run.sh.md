## Findings
### 1. Log polling can prevent the script from returning a verdict
- Severity: medium
- Confidence: high
- Location: tests/e2e/run.sh:175
- What happens: If the Job never produces accessible logs—for example, its pod cannot start—or cluster connectivity is lost before logs become available, the background polling loop continues indefinitely. The `pkill` only targets a `logs -f` process, which has not started, so `wait "$follow_pid"` never returns and the script cannot report failure or an inconclusive result.
- Evidence: `until k logs "job/$job" --tail=1 ...; do sleep 2; done` followed by `wait "$follow_pid"`.
- Fix idea: Explicitly terminate and reap the polling process after the grace period, including when it has not reached the streaming command.

### 2. A new run deletes active driver Jobs
- Severity: medium
- Confidence: high
- Location: tests/e2e/run.sh:86
- What happens: Starting a second run while another is active deletes the first run’s Job, interrupting its tests. This also deletes an unfinished Job deliberately retained by an earlier inconclusive run.
- Evidence: `k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --cascade=foreground --wait=true`
- Fix idea: Coordinate runs with a cluster-wide lock and refuse to start while a driver Job is active. Restrict stale-Job cleanup to Jobs known to be finished or abandoned.

### 3. The full suite continues after leaving an unfinished Job running
- Severity: medium
- Confidence: high
- Location: tests/e2e/run.sh:209
- What happens: In an `all` run, if a Job’s status is temporarily unreadable while it is still running, the script preserves it as intended but immediately starts the next phase. The two phases can then run concurrently against shared test resources, or the new Job can block on the shared driver volume, invalidating the suite results.
- Evidence: `keep_job=1` in the inconclusive branch, followed by `for phase in "${phases[@]}"; do run_phase "$phase"; done`.
- Fix idea: Stop launching further phases after an inconclusive result and report how to inspect the retained Job.

END-OF-REPORT
