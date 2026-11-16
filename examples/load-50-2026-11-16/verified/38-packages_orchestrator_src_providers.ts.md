### 1. Removing a provider from the allowlist breaks existing conversations
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/providers.ts:44-52
- Duplicate of: none
- Reasoning: Only providers named by `config.models.allowed` are installed (`if (wanted.has(provider.id)) models.setProvider(provider)`). docs/model-credentials.md:111-114 says a missing provider makes runs fail with `no_model` and that "removing a model from the allowlist stops new sessions only: existing conversations keep it". That holds only while another model of the same provider stays allowed; removing the last one, then restarting, makes stored conversations of that provider fail. Triggered by an operator config change, so medium rather than high; the doc/code contract is violated either way (and the doc's `providers.ts` comment says "every provider a stored conversation may name").
