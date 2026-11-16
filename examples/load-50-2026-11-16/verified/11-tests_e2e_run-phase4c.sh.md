### 1. Credential-leak checks do not assert their results
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): tests/e2e/run-phase4c.sh:177-178
- Duplicate of: none
- Reasoning: Both commands (`env | grep -c -E 'ghs_|github_pat_' || true` and the `grep -r -c ... || true` on .git/config and .onecli) only print counts into the stream. No later line of t_clone_push checks them (the only `ghs_` assertion, line 204, greps the orchestrator log, not the sandbox). The file header claims the test proves "no GitHub token is readable in the sandbox", so a leaked token passes. Test-quality gap, not a product bug, hence medium rather than high.

### 2. OneCLI HTTP errors can be mistaken for successful deletion
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4c.sh:55 (used at 153-154, 262-264)
- Duplicate of: none
- Reasoning: The `onecli` helper does `process.stdout.write(await r.text() || "[]")` with no status check. A 401/500 JSON error body piped through `jq '[.. | objects | select(.identifier? == $n)] | length'` yields 0, so t_delete's "agent is gone" and "secrets are gone" asserts pass on an auth failure. The grants-for-old-agent assertion tolerates 404/errors by design. Same helper is checked positively in t_clone_push (expects exactly 2), which limits the blast radius to the negative assertions.

### 3. The no-repo answer check matches the input message
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4c.sh:150-151
- Duplicate of: none
- Reasoning: `send "$id" plain-done ...` posts `{steps, final:"plain-done"}` as the message text, and `stream_has` searches the whole SSE stream (the script's own comment at 124-126 says "stream_has searches the whole stream, the user's message included"). The user message entry therefore satisfies the needle even if no turn ever runs. The following SQL and OneCLI assertions are mostly "nothing exists" checks that also hold for a session that never ran. Should use `answer_has` like clone-push.

### 4. Empty session lists make cleanup fail
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/run-phase4c.sh:68
- Duplicate of: none
- Reasoning: With `set -euo pipefail`, `list=$(grep -v '^$' "$sessions_file" | ...)` returns 1 when the file is empty. Reproduced in bash: an EXIT-trap function with that line aborts before the next command (the `rm -rf "$work"` never runs) and the script exits 1. Trigger: `ONLY=scope` (or restart-skip/delete) without a prior clone-push, or REPO_A/B unset with ONLY=clone-push, so no session id is appended.
