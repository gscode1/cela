## Findings

### 1. Filesystem errors are treated as a lost workspace
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/workspace.ts:64
- What happens: If an `exists` call fails transiently after a session was prepared, it is treated as a missing repository or marker. `prepareWorkspace` then throws `WorkspaceLostError`, and the caller permanently fails the session instead of retrying.
- Evidence: `return checked.ok && checked.value;`
- Fix idea: Propagate errors from `exists`; treat only a successful `false` result as absence.

### 2. A failed system CA read silently removes public trust roots
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/workspace.ts:82
- What happens: If reading the system certificate bundle fails, including due to a transient environment error, preparation succeeds with a bundle containing only the OneCLI CA. Commands using `SSL_CERT_FILE` or `GIT_SSL_CAINFO` then fail TLS verification for tunneled hosts presenting publicly trusted certificates.
- Evidence: `const bundle = system.ok ? ... : ca;`
- Fix idea: Propagate the read failure so preparation can be retried, or explicitly provide a verified alternative system bundle.

END-OF-REPORT
