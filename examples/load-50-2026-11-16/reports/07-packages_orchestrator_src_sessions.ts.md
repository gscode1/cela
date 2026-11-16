## Findings

### 1. A terminal failure can race with a new submission

- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:204
- What happens: An inbox row can read an active session, then pause while the watcher marks that session failed and aborts its conversation. The row resumes and submits its input after the abort, allowing another provider call in a terminally failed session.
- Evidence: `if (session.status === "failed")` is checked before the asynchronous budget and repository preparation calls, followed by `await this.#host.submitInput(...)`.
- Fix idea: Serialize terminal failure and submission per session, and verify the current session state within that coordination before admitting an input.

### 2. Retrying an admitted input can fail it at the budget check

- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:210
- What happens: If the process dies after handing an input to Pi Durable but before marking its inbox row submitted, the input can consume the remaining budget. On restart, its retry fails the budget check before reaching the idempotent submission, so an input that was already processed is recorded as failed.
- Evidence: `await this.#withinBudget(session, conversationId)` runs before `submitInput`; the existing submission lookup is gated by `faultArmed`.
- Fix idea: Check whether the request ID was already admitted before applying admission-time budget and repository checks. Restore its watch and treat it as handed over if it exists.

### 3. Conversation creation can race with deletion

- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:182
- What happens: A stream request can begin creating a conversation while deletion reads a session with no conversation ID. Deletion then skips stream closure and sandbox cleanup, while creation can attach a conversation to the already-deleted session. The stream can remain open after deletion.
- Evidence: Creation updates `conversation_id` with only `where id = $2 and conversation_id is null`; deletion performs conversation cleanup only when its snapshot’s `conversationId !== null`.
- Fix idea: Coordinate creation with deletion, conditionally attach only to a session still eligible for creation, and close streams even when the deletion snapshot has no conversation.

### 4. A crash can leave a completed deletion permanently incomplete

- Severity: low
- Confidence: high
- Location: packages/orchestrator/src/sessions.ts:305
- What happens: If the process crashes or `completeTombstone` fails after the session is marked deleted, the delete row is retried. The retry is rejected because the session is already deleted, leaving the tombstone incomplete and the delete event marked failed despite cleanup having run.
- Evidence: The status update precedes `await completeTombstone(...)`, while `apply` immediately throws `PermanentError` for a deleted session.
- Fix idea: Make the final status and tombstone updates atomic, or allow a delete retry for an already-deleted session to complete the tombstone successfully.

END-OF-REPORT
