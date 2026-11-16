### 1. A lost DELETE response can leave the gateway without a block rule
- Verdict: PLAUSIBLE
- Severity (verified): medium
- Location (verified): deploy/onecli-host-rules.sh:84-87
- Duplicate of: none
- Reasoning: `api DELETE ... >/dev/null` runs under `set -e`; if curl fails after the server already deleted the rule (timeout, reset after the request was processed), the script exits with `block_gone=0`, so `restore_block` does nothing, despite the comment "an HTTP error here means nothing was deleted" (true for `--fail-with-body` HTTP errors, not for transport errors). The allowlist is then off until the operator reruns `--apply` (which sees no block and creates it). Requires a transport failure in a narrow window; the script is a manual operator tool, so medium not high.

### 2. Existing rule names are trusted without checking their contents or order
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): deploy/onecli-host-rules.sh:59-61, 64
- Duplicate of: none
- Reasoning: Rules are matched by `.name` only (`has`, `select(.name==$n)`), so a hand-edited `pi-block-all` or `pi-allow-*` rule is accepted and success is printed. The script itself always creates allows before the block, so no ordering problem arises from its own runs; the failure needs manual tampering or a concurrent writer. The header states "Rules are matched by name" as the design, so this is a hardening gap, not a defect.

### 3. Dry runs unnecessarily require the admin key
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): deploy/onecli-host-rules.sh:36-40
- Duplicate of: none
- Reasoning: The key lookup (kubectl read of secret-store/pi-onecli-admin) and the `[[ -n $key ]] || exit 1` check happen before and independently of `$apply`, while the dry run claims "not contacting OneCLI" and never calls `api`. A dry run therefore fails for an operator without secret access. Minor usability issue.
