## Findings
### 1. Clearing the in-flight record can race with the next command
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sandboxes.ts:202
- What happens: After a command finishes, its database record is cleared asynchronously without blocking the next command. If the next command sets the record before the earlier clear completes, the clear can leave the record unset while the new command is running. An orchestrator crash then fails to trigger the required Pod recycle on restart, allowing leftover processes to survive.
- Evidence: `usage.recorded = false; void this.#hooks.execInFlight?.(conversationId, false)`
- Fix idea: Serialize per-conversation record updates and wait for a pending clear before recording and starting another command.

END-OF-REPORT
