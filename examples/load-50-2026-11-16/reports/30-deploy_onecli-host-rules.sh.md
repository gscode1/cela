## Findings

### 1. A lost DELETE response can leave the gateway without a block rule
- Severity: high
- Confidence: high
- Location: deploy/onecli-host-rules.sh:85
- What happens: If OneCLI deletes the block rule but the response is lost or curl otherwise fails, the script exits before setting `block_gone`. The EXIT trap therefore does not restore the rule, leaving public hosts unrestricted by this allowlist.
- Evidence: `api DELETE "$rules_path/$block_id" >/dev/null` precedes `block_gone=1`.
- Fix idea: Treat a failed DELETE as an uncertain outcome. Re-fetch the rules and restore the block if it is absent, including when the response cannot be verified.

### 2. Existing rule names are trusted without checking their contents or order
- Severity: high
- Confidence: high
- Location: deploy/onecli-host-rules.sh:59
- What happens: If an existing `pi-block-all` rule has been edited to allow traffic or target something other than `*`, the script accepts it as the catch-all block. Likewise, an existing allow rule with incorrect contents is skipped. When all expected names exist, the script also does not check whether the block comes after the allows, yet reports success.
- Evidence: `has() { grep -qxF -- "$1" <<<"$names"; }` and `select(.name==$n) | .id`
- Fix idea: Validate each matching rule’s action and target, and verify the effective ordering before reporting success. Repair mismatches or stop with an explicit error.

### 3. Dry runs unnecessarily require the admin key
- Severity: low
- Confidence: high
- Location: deploy/onecli-host-rules.sh:36
- What happens: An operator without access to the Kubernetes secret or `ONECLI_API_KEY` cannot see the dry-run plan, even though dry run makes no OneCLI request and does not use the key.
- Evidence: Key retrieval and the nonempty-key check happen before `if [[ $apply -eq 1 ]]`.
- Fix idea: Retrieve and validate the admin key only in apply mode.

END-OF-REPORT
