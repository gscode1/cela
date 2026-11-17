### 1. Orchestrator code deployment can leave the service stopped and its code incomplete
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): deploy/retired-orchestrator-delivery:24 (scale to 0), :54 (rm -rf then tar), :58 (only scale-up)
- Reasoning: Line 24 runs `k scale deployment "$d" --replicas=0`; the EXIT trap (line 16) only removes the temp dir and the loader pod, never scales back up. If the loader pod never becomes Ready (line 52 `k wait` times out at 240s, e.g. image pull failure) or `k cp`/`k exec` at 53-54 fails, `set -e` exits with the orchestrator at 0 replicas. Line 54 runs `rm -rf /code/app && mkdir ... && tar xzf` in place, so a failed extraction leaves a partial or empty /code/app. Impact is limited because a rerun of the script repairs both; this is a lab PoC, so medium rather than high.

### 2. Secret-generation scripts expose credentials in process arguments
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): deploy/gen-secret.sh:22; deploy/gen-api-secret.sh:15
- Reasoning: Both scripts pass the secret as `--from-literal=master="$master"` / `--from-literal=tokens="$tokens"` in the kubectl argv, which is visible via `ps` to other local users for the process lifetime. The exposure window is a few hundred ms on an operator workstation (or inside the e2e driver Job container, where there is no other local user), and the secrets are for a lab PoC. The mechanism is real but needs a hostile co-resident local user; high is overstated.

### 3. A failed OneCLI policy update can leave the gateway allowlist disabled
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): deploy/onecli-host-rules.sh:67 (DELETE), :72 (allow POSTs), :76 (block POST)
- Reasoning: Line 67 `api DELETE "$rules_path/$block_id"` runs before the POSTs; `api` uses `curl --fail-with-body` and `set -e` is on, so any HTTP error or Ctrl-C on a POST (lines 72/76) exits with `pi-block-all` deleted and never recreated. The script comment and docs/onecli-host-rules.md:53 acknowledge a short window but not the failure case. Impact is mitigated by the second layer the docs describe (Cilium FQDN allowlist on the OneCLI pod, deploy/onecli-policies/egress.yaml), so a leaked token cannot actually reach arbitrary hosts via the pod unless that policy is also absent; a rerun restores the block. Hence medium, not high. The report's cited line 65 is the `if`; the delete is on 67.

### 4. Phase 4b cleanup can delete session rows before resource deletion completes
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4b.sh:98 (bounded wait), :102-105 (unconditional row delete)
- Reasoning: The loop at 98 exits when `$(now) -lt $deadline` fails after 180s even if `left` is still nonzero; the following loop at 102-105 then runs `delete from inbox.events ...; delete from inbox.sessions ...` for every id regardless, contradicting the comment at 93-94 ("Dropping them earlier would orphan a claim"). Also, if the count query fails, `... | tr -d ' ' || echo 1` yields an empty string (pipeline status is tr's), `[[ "" -ne 0 ]]` is false, and the wait ends immediately. Trigger: orchestrator slow or down so deletion is still pending at 180s, or API DELETE failing. Impact is leftover sandbox claims in a test namespace in the lab, so low. Report cited line 97 (deadline assignment); the relevant lines are 98 and 102-105.

Totals: confirmed=4 plausible=0 rejected=0
