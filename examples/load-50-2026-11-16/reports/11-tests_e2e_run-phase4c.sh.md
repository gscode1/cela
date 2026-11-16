## Findings

### 1. Credential-leak checks do not assert their results
- Severity: high
- Confidence: high
- Location: tests/e2e/run-phase4c.sh:177
- What happens: The clone-push test can pass even when a GitHub token is readable in the sandbox. The commands print match counts, but the test never examines them; errors are also suppressed with `|| true`.
- Evidence: `"env | grep -c -E 'ghs_|github_pat_' || true"`
- Fix idea: Make the commands emit an unambiguous success marker only when the inspected locations are readable and contain no token, then assert that marker.

### 2. OneCLI HTTP errors can be mistaken for successful deletion
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4c.sh:55
- What happens: `fetch` resolves on HTTP errors, so a JSON 401 or 500 response can be counted as zero agents or secrets. The deletion test can therefore pass without verifying that the OneCLI objects were removed.
- Evidence: `.then(async (r) => { process.stdout.write(await r.text() || "[]"); })`
- Fix idea: Reject unexpected HTTP statuses before returning the body. Handle an expected not-found response explicitly for the old agent’s grants.

### 3. The no-repo answer check matches the input message
- Severity: medium
- Confidence: high
- Location: tests/e2e/run-phase4c.sh:151
- What happens: `plain-done` is included in the posted scripted-model input, and `stream_has` searches the entire stream. The assertion can succeed even if the session never runs a turn or answers.
- Evidence: `send "$id" plain-done ...` followed by `stream_has alice "$id" plain-done 90`
- Fix idea: Use `answer_has` to check for assistant text after a tool call, as the repo tests do.

### 4. Empty session lists make cleanup fail
- Severity: low
- Confidence: high
- Location: tests/e2e/run-phase4c.sh:68
- What happens: If all selected tests skip before creating a session, `grep` returns 1 for the empty sessions file. With `set -e` and `pipefail`, the EXIT cleanup stops before removing its temporary directory and can turn an otherwise successful skipped run into a failure.
- Evidence: `list=$(grep -v '^$' "$sessions_file" | sed "s/.*/'&'/" | paste -sd, -)`
- Fix idea: Treat an empty file as a valid empty list without relying on a successful `grep` match.

END-OF-REPORT
