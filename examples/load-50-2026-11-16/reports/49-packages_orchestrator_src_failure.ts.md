## Findings
### 1. Unrelated numbers can be mistaken for HTTP status codes
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/failure.ts:16
- What happens: A transient model error such as `429 Too Many Requests; retry after 401 seconds` matches `401` and permanently fails the session as a credential rejection. Queued inputs are then aborted, even though the session should remain usable.
- Evidence: `(?<![a-z0-9])(?:401|403|407)(?![a-z0-9])` matches any standalone occurrence, not just an HTTP status.
- Fix idea: Match numeric codes only in recognizable status-code contexts, or propagate a structured HTTP status separately from the error text. Add tests for unrelated standalone numbers in transient errors.

END-OF-REPORT
