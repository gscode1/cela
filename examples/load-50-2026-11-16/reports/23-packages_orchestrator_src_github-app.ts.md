## Findings

### 1. GitHub rate limiting can permanently fail a session
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/github-app.ts:104
- What happens: GitHub can return HTTP 403 for a temporary rate limit, but the minting code classifies every 403 as a permanent access denial. During repository preparation, the caller then fails the session instead of retrying after the limit resets.
- Evidence: `response.status === 403` leads to `throw new GithubDeniedError(message)`.
- Fix idea: Distinguish rate-limit responses using GitHub’s response headers and message, and treat them as retryable. Expose the necessary headers through `FetchLike`.

END-OF-REPORT
