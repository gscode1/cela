### 1. Slash-delimited keys allow a different model pair through the allowlist
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/session-core/src/models.ts:99-103 (key built at 13-15)
- Duplicate of: none
- Reasoning: `chooseModel` compares `modelKey(choice) === key` where the key is `${provider}/${model}`, and the only validation on the request is non-empty strings (ingest/src/server.ts:156), so provider `openrouter/openai` + model `gpt-4.1-nano` equals allowed `openrouter/openai/gpt-4.1-nano` and `requested` (with the wrong pair) is stored. It is not an allowlist bypass to an unlisted model: provider `openrouter/openai` is not installed in providers.ts, so the session simply fails at model resolution later. Effect is a bad session instead of a 400.
