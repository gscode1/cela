## Findings

### 1. Orphan deletion can delete a newly created claim or an in-use PVC
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/kube.ts:142
- What happens: For a lone-PVC sweep, the claim can be absent at the initial GET and then be created by a live session before the DELETE. The loop deletes that new claim without checking its label. Alternatively, the claim can appear after the claim DELETE returns 404 but before the PVC DELETE, so the sweep deletes the workspace the new claim is using. The same unchecked loop can delete a replacement claim after an initially matching claim disappears.
- Evidence: The label is checked once with `getNamespacedCustomObject`; subsequently the loop calls `deleteNamespacedCustomObject(claim)` and, on 404, `deleteNamespacedPersistentVolumeClaim(pvc)`.
- Fix idea: Coordinate creation and teardown per claim, including across ownership changes. Bind claim deletion to the checked UID and resource version, and protect the PVC deletion against a claim appearing before it completes.

### 2. Repository preparation bypasses lifecycle tracking
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/host.ts:279
- What happens: Repository preparation obtains the raw environment rather than the tracked proxy. A clone or other preparation operation can therefore run while an idle-suspend or recycle operation closes its bridge or deletes its Pod. These opens also create no usage entry, so a bridge opened solely for repository preparation is not visited by idle eviction and can remain until shutdown.
- Evidence: `workspaceEnv` returns `(await this.#sandboxes.ensure(id)).env`; `sessions.ts` passes it to `repos.prepare`, while eviction iterates `#usage` and busy tracking is performed in `lazyEnv`.
- Fix idea: Route workspace preparation through the same tracked, replacement-aware environment as tool calls. Ensure every opened bridge is registered for eviction.

### 3. Failed recycling allows calls into a potentially dirty sandbox
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sandboxes.ts:222
- What happens: If Pod recycling fails after an interrupted command or during restart recovery, the replacement promise catches the error and resolves. A waiting tool call then proceeds into the sandbox even though an escaped child may still be running. The interrupted marker is retried only after that call settles, rather than preventing the call.
- Evidence: The catch adds the conversation to `#interrupted` but does not rethrow; callers `await this.#replacing.get(conversationId)` before opening the environment.
- Fix idea: Keep the sandbox unavailable until recycling succeeds, or propagate the failure to waiting calls and retry recycling before admitting another call.

### 4. Clearing the in-flight record races with the next command
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/sandboxes.ts:194
- What happens: After one command finishes, its asynchronous database clear is not awaited. A new command can set the record to true, then the earlier clear can complete afterward and set it to false while the new command is running. If the orchestrator crashes then, restart recovery has no record requiring the Pod to be recycled.
- Evidence: `usage.recorded = false; void this.#hooks.execInFlight?.(conversationId, false)` runs independently of the next call’s awaited `execInFlight(..., true)`.
- Fix idea: Serialize record updates per conversation and prevent a stale clear from overtaking a new set.

### 5. Noncanonical sweep names can target a different workspace
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/sandboxes.ts:353
- What happens: The sweep accepts names such as `pi-conv-01`, but converts the suffix to a number and reconstructs `pi-conv-1` for teardown. A planned deletion of `workspace-pi-conv-01` can consequently delete `workspace-pi-conv-1` if its claim is absent, even when conversation 1 is live. Teardown can also close conversation 1’s bridge before the claim-label check rejects a mismatched claim.
- Evidence: `conversationOfName` uses `Number(match[1])`; `destroyOrphan` passes that number to `#teardown`, which calls `claimNameFor(conversationId)`.
- Fix idea: Require canonical decimal names before planning or executing a sweep, and retain the exact resource name through deletion rather than reconstructing it.

## Areas checked with no findings
- Per-claim token adoption: existing claims are checked for both the session label and the expected token hash, including after a create conflict.
- Failed session-list queries: a rejected query aborts the sweep before actions are planned.
- Timer shutdown: the normal close path stops the sandbox timers and closes cached bridges.

END-OF-REPORT
