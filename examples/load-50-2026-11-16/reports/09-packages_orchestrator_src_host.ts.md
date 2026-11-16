## Findings

### 1. Failed control-session creation can leak a sandbox
- Severity: low
- Confidence: high
- Location: packages/orchestrator/src/host.ts:128
- What happens: If sandbox creation partially succeeds and then fails, or submitting the first input fails, the request returns without the conversation ID and without deleting the claim. A retry creates a new conversation and claim. The orphan sweep explicitly excludes control-session claims, so the abandoned resources are not reclaimed by it.
- Evidence: `await this.#sandboxes.ensure(id);` is followed by `await conversation.submit(...)` with no cleanup on failure.
- Fix idea: Clean up the sandbox on failed creation, and provide recovery for a process crash between claim creation and returning the ID.

END-OF-REPORT
