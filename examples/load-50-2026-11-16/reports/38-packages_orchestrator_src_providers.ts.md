## Findings
### 1. Removing a provider from the allowlist breaks existing conversations
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/providers.ts:44
- What happens: If the last model for a remote provider is removed from the allowlist and the orchestrator restarts, that provider is not installed. Existing conversations using it can no longer resolve their stored model for subsequent requests or resumed runs. The documented policy says allowlist removal stops new sessions only.
- Evidence: `const wanted = new Set(remote.map((choice) => choice.provider));` followed by `if (wanted.has(provider.id)) models.setProvider(provider);`
- Fix idea: Install providers needed by persisted conversations independently of the new-session allowlist, and configure the gateway whenever those conversations require it. Add a restart test that removes a provider from the allowlist while retaining a conversation that uses it.

END-OF-REPORT
