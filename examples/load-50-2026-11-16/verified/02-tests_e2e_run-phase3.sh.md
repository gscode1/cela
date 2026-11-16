### 1. Isolation can pass without checking every denied target
- Verdict: REJECTED
- Severity (verified): n/a
- Location (verified): tests/e2e/run-phase3.sh:422-429
- Duplicate of: none
- Reasoning: The probe is one bash command that runs the nine probes sequentially and the `probe` function always echoes either REACHABLE or BLOCKED; `internet-direct` and `onecli-gateway` are the last two. The scenario needs a result with the last two lines present but an earlier denied line missing, which cannot happen from a sequential script (an incomplete run would also lack the gateway line and fail `test "$control" = REACHABLE`). Also `wait_session ... (.results|length)==2` is asserted before reading.

### 2. Known-fail classification can hide a broken gateway
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase3.sh:425-427
- Duplicate of: none
- Reasoning: `exit 3 # KNOWN-FAIL` fires when `reach>0 && blocked==0` before the `$control` assertion at :431, so with no enforcement and a dead gateway the gateway failure is never checked, and `record` maps rc 3 to KNOWN-FAIL with overall exit 0. Narrow: the suite already reports isolation as known-fail, and the gateway is exercised by other phases; the only loss is the gateway-down signal in this state.

### 3. A failed double-owner test can leave the second orchestrator running for later tests
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase3.sh:233 (delete) vs 202 (test start)
- Duplicate of: none
- Reasoning: `run_test` runs `t_double_owner` in a `set -e` subshell; any failed assert/`wait_for` exits before `k delete deployment pi-orchestrator-b --wait=true`, and `trap cleanup` only runs at script exit. `long-command` then runs with B still waiting for the lock (and possibly holding it). The suite is already FAIL at that point, so the harm is misleading follow-on failures in `long-command`.
