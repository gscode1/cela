## Findings

### 1. Orphan-sweep test can overwrite and delete an existing claim
- Severity: high
- Confidence: high
- Location: tests/e2e/run-phase4.sh:631
- What happens: The test uses fixed claim names in the shared namespace. If, for example, `pi-conv-990001` already belongs to a real session or another test run, `mkclaim` applies its test configuration to that claim and records the name for unconditional deletion during cleanup. This can disrupt the existing sandbox and delete its workspace.
- Evidence: `mkclaim pi-conv-990001 "$unknown_label"`; `mkclaim` uses `k apply -f -`, and cleanup deletes every name in `extra_claims_file`.
- Fix idea: Generate unique claim names for each run and create them with `kubectl create`, failing on a collision. Only register resources for cleanup after confirming this run created them.

### 2. Cleanup drops session records even when API deletion failed
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4.sh:81
- What happens: If API deletion does not finish within the deadline, cleanup deletes the claim and PVC directly, then removes the session row anyway. The normal deletion path also revokes OneCLI resources; removing the row prevents that path from retrying, potentially leaving credentials and other resources behind.
- Evidence: `api "$owner" DELETE "/sessions/$id" ... || true` followed by `delete from inbox.events ...; delete from inbox.sessions ...` regardless of deletion status.
- Fix idea: Retain undeleted session rows so the orchestrator can retry deletion, or explicitly complete and verify all normal deletion steps before removing them.

END-OF-REPORT
