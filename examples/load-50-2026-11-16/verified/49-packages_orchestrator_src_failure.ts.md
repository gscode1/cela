### 1. Unrelated numbers can be mistaken for HTTP status codes
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/failure.ts:15-16,30
- Duplicate of: none
- Reasoning: The regex `(?<![a-z0-9])(?:401|403|407)(?![a-z0-9])` matches any standalone number, including `403.5` (followed by `.`) or `407 tokens`; for `reason === "model_error"` the whole detail text (watcher.ts:67-72) is tested, and `#runEnded` then calls `failSession`, permanently ending the session. The existing tests only cover digits adjacent to alphanumerics (`4010293`, `14031 bytes`). The report's literal example (`retry after 401 seconds`) is contrived, but a provider error carrying a bare 401/403/407 outside a status role is possible, and the comment openly accepts the heuristic. Mechanism real, trigger uncommon.
