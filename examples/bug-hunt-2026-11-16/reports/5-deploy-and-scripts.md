## Findings

### 1. Orchestrator code deployment can leave the service stopped and its code incomplete
- Severity: high
- Confidence: high
- Location: deploy/retired-orchestrator-delivery:23
- What happens: The script scales the orchestrator to zero before loading code. If the loader fails to start, copying fails, or extraction fails, `set -e` exits without scaling the deployment back up. An extraction failure can also leave `/code/app` incomplete because the old bundle was deleted first.
- Evidence: `k scale deployment "$d" --replicas=0`; later, `rm -rf /code/app ... && tar xzf ...`; scaling back occurs only at line 58.
- Fix idea: Stage and validate the new bundle separately, then atomically replace the old bundle. Restore the previous replica counts on failure as well as success.

### 2. Secret-generation scripts expose credentials in process arguments
- Severity: high
- Confidence: high
- Location: deploy/gen-secret.sh:22
- What happens: While `kubectl` is running, a local user or process able to inspect its command line can read the sandbox master key. `deploy/gen-api-secret.sh` similarly puts both API bearer tokens in `kubectl` arguments. The master key permits derivation of every sandbox daemon token.
- Evidence: `--from-literal=master="$master"`; `deploy/gen-api-secret.sh:15` uses `--from-literal=tokens="$tokens"`.
- Fix idea: Pass secret data through stdin or another mechanism that does not put it in process arguments, and restrict access to any temporary files if files are used.

### 3. A failed OneCLI policy update can leave the gateway allowlist disabled
- Severity: high
- Confidence: high
- Location: deploy/onecli-host-rules.sh:65
- What happens: When adding an allowed host, the script deletes the existing catch-all block before creating the missing allow rules. If a subsequent API request fails or the script is interrupted, the block is not recreated, leaving valid agent tokens able to relay to arbitrary public hosts until an operator repairs the rules.
- Evidence: `api DELETE "$rules_path/$block_id"` precedes the POSTs for missing allows and the final `block '*'` POST.
- Fix idea: Use an atomic policy update if supported. Otherwise arrange a failure-safe restoration of the block rule and verify the resulting policy before reporting success.

### 4. Phase 4b cleanup can delete session rows before resource deletion completes
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4b.sh:97
- What happens: If session deletion remains pending beyond 180 seconds, or the API delete failed, cleanup still deletes the session rows. The asynchronous deletion process can lose the state it needs to finish removing the session’s sandbox and associated resources.
- Evidence: The wait is bounded by `$(now) -lt $deadline`, but the following loop unconditionally runs `delete from inbox.events ...; delete from inbox.sessions ...`.
- Fix idea: Delete rows only for sessions confirmed `deleted`; retain and report any that time out so cleanup can be retried.

## Areas checked with no findings
- Namespace baseline, sandbox ingress and egress policies, and Cilium API-server rules.
- Orchestrator RBAC against its documented sandbox lifecycle operations.
- Ingest and orchestrator pod security contexts.

END-OF-REPORT
