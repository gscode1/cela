### 1. GitHub rate limiting can permanently fail a session
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/github-app.ts:104-111, consumed at packages/orchestrator/src/sessions.ts:262-266
- Duplicate of: none
- Reasoning: Any 403 (as well as 401/404/422) throws `GithubDeniedError`; `#prepareRepo` maps that to `#failSession(... "GitHub refused access to the repository: is the GitHub App installed on it?")` plus `PermanentError`, so the session fails for good. GitHub answers primary and secondary rate limits with 403 (or 429, which here would be a retryable generic error), and token minting for many sessions at once (the 50-session load) can hit the secondary limit. The code does not inspect the message, `retry-after` or `x-ratelimit-remaining`. Severity medium: permanent session loss from a transient condition, but only under heavy minting.
