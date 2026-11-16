## Findings

### 1. Isolation can pass without checking every denied target
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase3.sh:422
- What happens: If the tool result is incomplete but contains reachable internet and gateway results, the test can pass without a result for one or more denied targets. It checks that the number of `REACHABLE` denied results is zero, but not that every expected target produced a `BLOCKED` result.
- Evidence: `assert ... test "$reach" -eq 0`
- Fix idea: Verify that the tool call succeeded and that each expected probe appears exactly once with the required outcome.

### 2. Known-fail classification can hide a broken gateway
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase3.sh:425
- What happens: When all reported denied targets are reachable, the test returns `KNOWN-FAIL` before checking the gateway control. A cluster with no NetworkPolicy enforcement **and** an unreachable required OneCLI gateway therefore gets a successful suite exit instead of a failure.
- Evidence: `exit 3 # KNOWN-FAIL` precedes the assertion that `$control` is `REACHABLE`.
- Fix idea: Validate probe completeness and the gateway control before classifying absent enforcement as a known failure.

### 3. A failed double-owner test can leave the second orchestrator running for later tests
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase3.sh:256
- What happens: Any assertion or timeout after creating `pi-orchestrator-b` exits the test subshell before deleting the deployment. The runner then proceeds to `long-command` with two orchestrators, potentially killing the wrong owner or producing unrelated failures. The top-level cleanup removes B only when the entire script exits.
- Evidence: `k delete deployment pi-orchestrator-b --wait=true` occurs only at the successful end of `t_double_owner`.
- Fix idea: Ensure B is deleted after the test regardless of its result, before running subsequent tests.

END-OF-REPORT
