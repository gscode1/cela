## Findings
### 1. Slash-delimited keys allow a different model pair through the allowlist
- Severity: medium
- Confidence: high
- Location: packages/session-core/src/models.ts:100
- What happens: If `openrouter/openai/gpt-4.1-nano` is allowed, a request with provider `openrouter/openai` and model `gpt-4.1-nano` passes the check even though that pair is not allowed. The requested pair is stored, and the session may then fail when the orchestrator tries to resolve the nonexistent provider.
- Evidence: `policy.allowed.some((choice) => modelKey(choice) === key)` compares concatenated strings, then returns `requested`.
- Fix idea: Compare provider and model fields separately. Alternatively, reject slashes in requested provider IDs before constructing the key.

END-OF-REPORT
