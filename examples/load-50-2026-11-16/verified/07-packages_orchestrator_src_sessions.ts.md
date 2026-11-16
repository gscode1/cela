### 1. A terminal failure can race with a new submission
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:204-219
- Duplicate of: none
- Reasoning: `apply` gets `session` from `getSession` in `#applyRow` before `ensureConversation`, `#withinBudget` and `#prepareRepo` (a clone can take seconds), then `submitInput`; the watcher's `#failSession` (status commit then `host.abort`) can run in between, so the input is submitted after the abort. The drain is serial per session but the watcher is a separate actor. Consequence is one extra provider call in a failed session (a turn_limit failure is re-caught by `#withinBudget`, rejected-credential failure just fails again); `#recoverFailedAborts` cleans up on restart. Narrow window, small impact.

### 2. Retrying an admitted input can fail it at the budget check
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:211
- Duplicate of: none
- Reasoning: On a crash after `submitInput` (:219) but before the row is marked submitted, the retry runs `#withinBudget` first; if the already-submitted input used the last turn, `left <= 0` fails the session and throws `PermanentError`, marking the row failed though Pi Durable already has it. Needs a crash in that window and that input exhausting the budget; the session would be failed for turn_limit at the next input anyway, so the effect is only a wrong row status/earlier failure.

### 3. Conversation creation can race with deletion
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:182-186 (http.ts:100, delete at :300)
- Duplicate of: none
- Reasoning: The stream handler reads the session (conversationId null, status not deleted) then `ensureConversation` -> `#create`; `#delete` meanwhile snapshot `conversationId === null` and skips abort/`closeSession`/`destroySandbox`. `#create` then attaches the id to the deleted row (`where id=$2 and conversation_id is null`) and the stream stays open. Impact is an empty conversation (a documented limit) and a stream lingering until the client disconnects: no sandbox is created without tool calls and no input is possible on a deleted session. Needs a stream request on a never-used session at the moment of deletion.

### 4. A crash can leave a completed deletion permanently incomplete
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sessions.ts:305-309 (guard at :200)
- Duplicate of: none
- Reasoning: The `status='deleted'` update (:305) and `completeTombstone` (:309) are separate statements; if the second fails or the process dies, the delete row retries and `apply` throws `PermanentError("session is deleted")` at the top, so the tombstone's `completed_at` stays null and the delete event ends `failed` (and a repeated DELETE returns early for `deleted`). Resources are already gone, so only bookkeeping is wrong.
